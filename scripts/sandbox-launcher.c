#define _GNU_SOURCE
#include <errno.h>
#include <elf.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

/* Landlock ABI 6 layout and flags, declared here so older kernel headers can still build the launcher.
   The running kernel's ABI is checked before any of them are used. */
struct minv_landlock_ruleset_attr { __u64 handled_access_fs; __u64 handled_access_net; __u64 scoped; };
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#endif
#ifndef LANDLOCK_SCOPE_SIGNAL
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif

static void fail(const char *message) {
  fprintf(stderr, "Minv Git sandbox: %s: %s\n", message, strerror(errno));
  exit(126);
}

static void readonly_landlock(int executable) {
  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 6) { errno = ENOTSUP; fail("Linux Landlock ABI 6 or newer is required"); }
  struct minv_landlock_ruleset_attr rules = {
    .handled_access_fs = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |
      LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
      LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM |
      LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE | LANDLOCK_ACCESS_FS_IOCTL_DEV,
    .scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL,
  };
  int fd = syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
  if (fd < 0) fail("cannot create filesystem confinement");
  struct landlock_path_beneath_attr binary = { .allowed_access = LANDLOCK_ACCESS_FS_EXECUTE, .parent_fd = executable };
  if (syscall(SYS_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, &binary, 0)) fail("cannot authorize the Git binary");
  Elf64_Ehdr elf;
  if (pread(executable, &elf, sizeof(elf), 0) != sizeof(elf) || elf.e_ident[EI_CLASS] != ELFCLASS64 || elf.e_phnum > 1024) { errno = ENOEXEC; fail("unsupported executable format"); }
  for (unsigned int index = 0; index < elf.e_phnum; index++) {
    Elf64_Phdr header;
    if (pread(executable, &header, sizeof(header), elf.e_phoff + index * elf.e_phentsize) != sizeof(header)) fail("cannot read ELF program header");
    if (header.p_type != PT_INTERP) continue;
    char loader[4096];
    if (!header.p_filesz || header.p_filesz > sizeof(loader) || pread(executable, loader, header.p_filesz, header.p_offset) != (ssize_t)header.p_filesz
        || loader[0] != '/' || loader[header.p_filesz - 1] != '\0') { errno = ENOEXEC; fail("invalid ELF interpreter"); }
    int interpreter = open(loader, O_PATH | O_CLOEXEC);
    if (interpreter < 0) fail("cannot resolve the ELF interpreter");
    binary.parent_fd = interpreter;
    if (syscall(SYS_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, &binary, 0)) fail("cannot authorize the ELF interpreter");
    close(interpreter);
  }
  int null_device = open("/dev/null", O_PATH | O_CLOEXEC);
  if (null_device < 0) fail("cannot resolve the null device");
  binary.parent_fd = null_device; binary.allowed_access = LANDLOCK_ACCESS_FS_WRITE_FILE;
  if (syscall(SYS_landlock_add_rule, fd, LANDLOCK_RULE_PATH_BENEATH, &binary, 0)) fail("cannot authorize the null device");
  close(null_device);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("cannot disable privilege changes");
  if (syscall(SYS_landlock_restrict_self, fd, 0)) fail("cannot restrict filesystem access");
  close(fd);
}

#define NOTIFY(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF)
#define DENY(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)

static int execution_filter(void) {
#if defined(__x86_64__)
  const unsigned int architecture = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
  const unsigned int architecture = AUDIT_ARCH_AARCH64;
#else
#error Unsupported Linux architecture
#endif
  struct sock_filter instructions[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, architecture, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    /* Reject the x32 syscall namespace as well as non-native architectures. */
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    /* A newer USER_NOTIF filter must not replace this supervisor's notification
     * decisions. Filter installation itself is allowed before this filter exists. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_prctl, 0, 3),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, PR_SET_SECCOMP, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    DENY(SYS_seccomp), DENY(SYS_ioctl),
    NOTIFY(SYS_execve), NOTIFY(SYS_execveat), NOTIFY(SYS_socket), NOTIFY(SYS_socketpair), NOTIFY(SYS_connect),
    DENY(SYS_ptrace), DENY(SYS_process_vm_writev), DENY(SYS_process_vm_readv),
    DENY(SYS_pidfd_getfd), DENY(SYS_open_by_handle_at), DENY(SYS_mount), DENY(SYS_umount2),
    DENY(SYS_unshare), DENY(SYS_setns), DENY(SYS_bpf), DENY(SYS_userfaultfd),
    DENY(SYS_perf_event_open), DENY(SYS_io_uring_setup),
    /* Landlock protects file contents, not every inode-metadata operation. */
    DENY(SYS_fchmod), DENY(SYS_fchmodat), DENY(SYS_fchown), DENY(SYS_fchownat),
    DENY(SYS_utimensat), DENY(SYS_setxattr), DENY(SYS_lsetxattr), DENY(SYS_fsetxattr),
    DENY(SYS_removexattr), DENY(SYS_lremovexattr), DENY(SYS_fremovexattr),
    DENY(SYS_add_key), DENY(SYS_request_key), DENY(SYS_keyctl),
#ifdef SYS_chmod
    DENY(SYS_chmod),
#endif
#ifdef SYS_chown
    DENY(SYS_chown),
#endif
#ifdef SYS_lchown
    DENY(SYS_lchown),
#endif
#ifdef SYS_utime
    DENY(SYS_utime),
#endif
#ifdef SYS_utimes
    DENY(SYS_utimes),
#endif
#ifdef SYS_futimesat
    DENY(SYS_futimesat),
#endif
#ifdef SYS_fchmodat2
    DENY(SYS_fchmodat2),
#endif
#ifdef SYS_mount_setattr
    DENY(SYS_mount_setattr), DENY(SYS_fsopen), DENY(SYS_fsconfig), DENY(SYS_fsmount),
    DENY(SYS_fspick), DENY(SYS_open_tree), DENY(SYS_move_mount),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(instructions) / sizeof(instructions[0]), .filter = instructions };
  int listener = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
  if (listener < 0) fail("cannot install executable/network confinement");
  return listener;
}

static void send_listener(int socket, int listener) {
  char data = 0;
  struct iovec payload = { .iov_base = &data, .iov_len = 1 };
  union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  struct msghdr message = { .msg_iov = &payload, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes) };
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  header->cmsg_level = SOL_SOCKET; header->cmsg_type = SCM_RIGHTS; header->cmsg_len = CMSG_LEN(sizeof(int));
  memcpy(CMSG_DATA(header), &listener, sizeof(listener));
  if (sendmsg(socket, &message, 0) != 1) fail("cannot hand off the seccomp listener");
}

static int receive_listener(int socket) {
  char data = 0;
  struct iovec payload = { .iov_base = &data, .iov_len = 1 };
  union { struct cmsghdr alignment; char bytes[CMSG_SPACE(sizeof(int))]; } control = {0};
  struct msghdr message = { .msg_iov = &payload, .msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes) };
  if (recvmsg(socket, &message, MSG_CMSG_CLOEXEC) != 1) fail("sandbox setup failed before launching Git");
  struct cmsghdr *header = CMSG_FIRSTHDR(&message);
  if (!header || header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS || header->cmsg_len != CMSG_LEN(sizeof(int))) { errno = EINVAL; fail("invalid sandbox listener"); }
  int listener; memcpy(&listener, CMSG_DATA(header), sizeof(listener));
  return listener;
}

int main(int argc, char **argv) {
  if (argc < 2 || argv[1][0] != '/') { errno = EINVAL; fail("an absolute Git executable is required"); }
  int executable = open(argv[1], O_RDONLY | O_CLOEXEC);
  if (executable < 0) fail("cannot open Git executable");
  unsigned char magic[4];
  if (pread(executable, magic, sizeof(magic), 0) != sizeof(magic) || memcmp(magic, "\177ELF", 4)) { errno = ENOEXEC; fail("passive reads require a native ELF Git binary, not an executable wrapper"); }
  int channel[2];
  if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, channel)) fail("cannot create sandbox control channel");
  pid_t child = fork();
  if (child < 0) fail("cannot create confined process");
  if (!child) {
    close(channel[0]);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() == 1) _exit(126);
    readonly_landlock(executable);
    int listener = execution_filter();
    send_listener(channel[1], listener);
    close(listener); close(channel[1]);
    syscall(SYS_execveat, executable, "", &argv[1], environ, AT_EMPTY_PATH);
    fail("cannot execute the pinned Git binary");
  }
  close(channel[1]);
  int listener = receive_listener(channel[0]);
  close(channel[0]); close(executable);
  int pidfd = syscall(SYS_pidfd_open, child, 0);
  if (pidfd < 0) { kill(child, SIGKILL); fail("cannot supervise Git lifetime"); }
  struct seccomp_notif_sizes sizes;
  if (syscall(SYS_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes)) { kill(child, SIGKILL); fail("cannot inspect seccomp notification format"); }
  struct seccomp_notif *request = calloc(1, sizes.seccomp_notif);
  struct seccomp_notif_resp *response = calloc(1, sizes.seccomp_notif_resp);
  if (!request || !response) { kill(child, SIGKILL); fail("cannot allocate sandbox notification"); }
  struct pollfd watched[] = { { .fd = listener, .events = POLLIN }, { .fd = pidfd, .events = POLLIN } };
  int launched = 0, blocked = 0, status = 0;
  for (;;) {
    if (poll(watched, 2, -1) < 0) { if (errno == EINTR) continue; kill(child, SIGKILL); fail("cannot supervise sandbox"); }
    if (watched[0].revents & POLLIN) {
      memset(request, 0, sizes.seccomp_notif); memset(response, 0, sizes.seccomp_notif_resp);
      if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, request)) { if (errno == EINTR || errno == ENOENT) continue; kill(child, SIGKILL); fail("cannot receive sandbox operation"); }
      response->id = request->id;
      /* The only permitted exec is our single-threaded launcher's initial execveat
       * of the already-open ELF inode. No untrusted pathname is read or approved. */
      if (!launched && request->pid == (unsigned int)child && request->data.nr == SYS_execveat
          && request->data.args[0] == (uint64_t)executable && request->data.args[4] == AT_EMPTY_PATH) {
        launched = 1; response->flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
      } else {
        blocked = 1; response->error = -EPERM;
        fprintf(stderr, "Minv Git sandbox: blocked executable helper or network access; this read is unsupported without running repository code.\n");
      }
      if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, response) && errno != ENOENT) { kill(child, SIGKILL); fail("cannot deny sandbox operation"); }
    }
    if (watched[1].revents & POLLIN) break;
  }
  if (waitpid(child, &status, 0) < 0) fail("cannot collect Git result");
  close(listener); close(pidfd); free(request); free(response);
  if (blocked) return 125;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}

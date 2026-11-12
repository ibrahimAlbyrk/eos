#!/usr/bin/env python3
"""Records what real programs write to a terminal: captures/<name>.bin.

    python3 capture.py

Each session runs in its own PTY (80x24, TERM=xterm-256color) with an empty
environment and an invented file, and is driven by a fixed list of
keystrokes. The bytes are the fixture; they are recorded once and committed,
because a pager's or an editor's exact output depends on its version.
"""
import fcntl
import os
import pty
import select
import struct
import sys
import tempfile
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))


def run(name, argv, keys, cwd):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        env = {"TERM": "xterm-256color", "PATH": "/usr/bin:/bin", "HOME": cwd, "LANG": "en_US.UTF-8", "PS1": "$ "}
        os.execve(argv[0], argv, env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    out = bytearray()

    def drain(seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    return False
                if not chunk:
                    return False
                out.extend(chunk)
        return True

    drain(0.6)
    for key in keys:
        os.write(fd, key.encode())
        if not drain(0.3):
            break
    drain(0.4)
    try:
        os.close(fd)
    except OSError:
        pass
    os.waitpid(pid, 0)
    with open(os.path.join(HERE, "captures", name + ".bin"), "wb") as f:
        f.write(out)
    print(name, len(out), "bytes")


def main():
    with tempfile.TemporaryDirectory() as cwd:
        with open(os.path.join(cwd, "notes.txt"), "w") as f:
            for i in range(200):
                f.write("line %03d  %s\n" % (i, "lorem ipsum dolor sit amet " * (1 + i % 4)))
        sh = ["/bin/sh", "-i"]
        # A pager: open, page down, search, jump to the end, quit, back at the prompt.
        run("less", sh, ["less notes.txt\r", " ", "j", "j", "/line 05\r", "n", "G", "g", "q", "echo done\r", "exit\r"], cwd)
        # An editor: open, move, insert text, delete a line, split, quit without saving.
        run(
            "vim",
            sh,
            ["vim -u NONE -N notes.txt\r", "5j", "wll", "iinserted \x1b", "dd", "G", ":split\r", "\x04", ":q!\r", ":q!\r", "exit\r"],
            cwd,
        )
        # The pager left open: the snapshot is taken on the alternate screen.
        run("less-open", sh, ["less notes.txt\r", " ", "/lorem\r"], cwd)


if __name__ == "__main__":
    sys.exit(main())

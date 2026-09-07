# Base image for cezar agent containers.
#
# A repo's own image is expected to build FROM this and add its toolchain, so
# the long-lived per-repo container starts with dependencies already present —
# that is what "each new task must not get a clean image" means in practice.
FROM docker.io/library/node:22-bookworm

# What cezar's agents assume exists: git (worktrees), gh (pull requests),
# ripgrep (the Grep tool's fast path), less (pagers that would otherwise hang).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg ripgrep less \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI from its own repo — Debian's package is far behind.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# The agent CLI itself.
RUN npm install -g @anthropic-ai/claude-code

# Agent scratch, deliberately NOT on any bind mount: the native claude binary
# does a startup temp-file operation that a macOS bind mount cannot serve, and
# dies with an opaque "ENOENT: no such file or directory, fstat" before it logs
# anything. cezar's per-run TMPDIR points into the repo, so the launcher
# overrides it to this path.
ENV TMPDIR=/tmp/cez-agent
RUN mkdir -p /tmp/cez-agent

# The agent's own Claude identity is mounted here (see the launcher): a volume,
# so conversations survive the container and can never be stranded inside a
# stopped one.
VOLUME ["/root/.claude"]

CMD ["sleep", "infinity"]

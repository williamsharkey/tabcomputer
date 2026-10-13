# tabcomputer.com

tabcomputer (desktop UI, see `src/ui-mode.ts`) runs on its own
DigitalOcean droplet, `tabcomputer` (s-1vcpu-2gb-amd, nyc1; the plain
s-1vcpu-2gb size is retired). shiro.computer and its
droplet are not involved.

- **Setup:** the droplet was created with `cloud-init.yaml` as its user data.
  On first boot it installs node 22, nginx and certbot, and enables three
  systemd units: `tabcomputer` (server.mjs on :3000 behind nginx), the
  `tabcomputer-deploy.timer` and the `tabcomputer-cert.timer`.
- **Settings and build steps** live in this directory: `release.sh` builds a
  release and `profiles/tabcomputer/server.env` is the server's environment (TCP relay on, GitHub
  sign-in off for now). Both ship with the commit, so changing them is a push.
- **Deploy:** github.com/williamsharkey/tabcomputer is the source repository;
  `main` is its integration branch. The coordinator ships by fast-forwarding
  `deploy` to a tested `main` commit: `git push origin <commit>:refs/heads/deploy`,
  and records the release (build number, commit, date) in docs/RELEASES.md
  (git tags are blocked by the proxy). Workers never push `main` or `deploy`. Within about 2
  minutes the droplet notices, runs `npm ci && npm run build`, and switches
  `/opt/tabcomputer/current` to the new release; building takes several
  minutes on this size (with a 1.5 GB node heap and a 2 GB swapfile, which
  release.sh sets up). The build log is at `/_deploy/log`. `https://tabcomputer.com/deployed.txt` shows the live
  commit. A commit whose build fails is recorded in `/opt/tabcomputer/FAILED_SHA`
  and skipped; the previous release keeps serving. The last 3 releases are kept.
- **Disk caches:** `/claude-releases/` (server.mjs, `claude install`) keeps
  Anthropic's sha256-checked native Claude Code builds in `$TMPDIR/shiro-claude`
  (`TABCOMPUTER_CLAUDE_CACHE`): the newest 3 versions (`TABCOMPUTER_CLAUDE_KEEP`)
  plus at most 2 downloads in flight (`TABCOMPUTER_CLAUDE_DOWNLOADS`), about
  250 MB each, so 1.25 GB at most. `TABCOMPUTER_CLAUDE_RELEASES=0` turns the
  route off; clients then download through the TCP relay.
  `/pyodide/` (server.mjs, numpy and the other compiled Python packages)
  keeps the files of the pinned Pyodide version that browsers ask for in
  `/opt/tabcomputer/pyodide` (`TABCOMPUTER_PYODIDE_CACHE` in
  `profiles/tabcomputer/server.env`; the server makes the directory): each
  fetched from cdn.jsdelivr.net once and sha256-checked, about 30 MB after
  numpy, pandas and matplotlib, never more than
  `TABCOMPUTER_PYODIDE_CACHE_MAX_MB` (1024). Deleting the directory is safe:
  files are fetched again. `TABCOMPUTER_PYODIDE=0` turns the route off; pages
  then use jsdelivr. A new Pyodide version leaves the old version's directory
  behind; remove it by hand.
- **TLS:** `tabcomputer-cert` waits until tabcomputer.com and www resolve to
  the droplet, then runs `certbot --nginx --redirect` once. certbot's own
  timer renews it.
- **DNS** is at Porkbun: A records for `tabcomputer.com` and
  `*.tabcomputer.com` point at the droplet. Email forwarding (MX/SPF) is
  Porkbun's.

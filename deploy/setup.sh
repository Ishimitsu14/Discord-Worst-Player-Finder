#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 077
[[ $(id -u) == 0 && $(uname -m) == x86_64 ]] || exit 64
base=/opt/discord-worst-player-finder
config=/etc/discord-worst-player-finder
data=/var/lib/discord-worst-player-finder
work=$(cd "$(dirname "$0")" && pwd)
version=22.23.3
archive="node-v$version-linux-x64.tar.xz"
digest=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
if [[ ! -f "$base/.managed-wpf" ]]; then
  [[ ! -e "$base" && ! -e "$config" && ! -e "$data" && ! -e /etc/systemd/system/worst-player.service && ! -e /etc/sudoers.d/wpf-deploy ]] || exit 65
  ! getent passwd worst-player >/dev/null
  ! getent passwd worst-player-deploy >/dev/null
  ! getent group worst-player-code >/dev/null
  install -d -m 0750 "$base"
  printf '%s\n' 'discord-worst-player-finder-v1' > "$base/.managed-wpf"
fi
[[ $(cat "$base/.managed-wpf") == discord-worst-player-finder-v1 ]] || exit 65
getent group worst-player-code >/dev/null || groupadd --system worst-player-code
id worst-player >/dev/null 2>&1 || useradd --system --user-group --home-dir "$data" --shell /usr/sbin/nologin --groups worst-player-code worst-player
id worst-player-deploy >/dev/null 2>&1 || useradd --system --user-group --create-home --home-dir /home/worst-player-deploy --shell /bin/bash --password '*' --groups worst-player-code worst-player-deploy
chown root:worst-player-code "$base"
install -d -o worst-player-deploy -g worst-player-code -m 2750 "$base/releases" "$base/incoming"
install -d -o root -g worst-player-code -m 0750 "$base/runtimes"
if [[ ! -f "$base/deploy.lock" ]]; then install -o worst-player-deploy -g worst-player-code -m 0640 /dev/null "$base/deploy.lock"; fi
install -d -o root -g worst-player -m 0750 "$config"
install -d -o worst-player -g worst-player -m 0700 "$data" "$data/backups"
if [[ ! -f "$data/service.lock" ]]; then install -o worst-player -g worst-player -m 0600 /dev/null "$data/service.lock"; fi
if [[ ! -f "$config/service.env" ]]; then install -o root -g worst-player -m 0640 /dev/null "$config/service.env"; fi
if [[ ! -x "$base/runtimes/node-v$version-linux-x64/bin/node" ]]; then
  curl --fail --silent --show-error --location --max-time 120 "https://nodejs.org/dist/v$version/$archive" -o "$work/$archive"
  printf '%s  %s\n' "$digest" "$work/$archive" | sha256sum --check --status
  tar --no-same-owner -xJf "$work/$archive" -C "$base/runtimes"
  chown -R root:root "$base/runtimes/node-v$version-linux-x64"
fi
if [[ ! -e "$base/runtime" ]]; then ln -s "runtimes/node-v$version-linux-x64" "$base/runtime"; fi
[[ $("$base/runtime/bin/node" --version) == "v$version" ]] || exit 65
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$work/control.sh" /usr/local/libexec/wpf-control
install -o root -g root -m 0755 "$work/receive.sh" /usr/local/libexec/wpf-receive
ssh-keygen -lf "$work/actions.pub"
key=$(cat "$work/actions.pub")
[[ "$key" == ssh-ed25519\ * ]] || exit 65
install -d -o root -g worst-player-deploy -m 0750 /home/worst-player-deploy
install -d -o root -g worst-player-deploy -m 0750 /home/worst-player-deploy/.ssh
authorized=/home/worst-player-deploy/.ssh/authorized_keys
if [[ ! -f "$authorized" ]]; then install -o root -g worst-player-deploy -m 0640 /dev/null "$authorized"; fi
line="restrict,command=\"/usr/local/libexec/wpf-receive\" $key"
grep -qxF "$line" "$authorized" || printf '%s\n' "$line" >> "$authorized"
printf '%s\n' 'worst-player-deploy ALL=(root) NOPASSWD: /usr/local/libexec/wpf-control *' > "$work/sudoers"
visudo -cf "$work/sudoers"
install -o root -g root -m 0440 "$work/sudoers" /etc/sudoers.d/wpf-deploy
install -o root -g root -m 0644 "$work/worst-player.service" /etc/systemd/system/worst-player.service
systemd-analyze verify /etc/systemd/system/worst-player.service
systemctl daemon-reload
printf 'prepared node=%s unit=%s\n' "$("$base/runtime/bin/node" --version)" "$(systemctl is-enabled worst-player.service || true)"

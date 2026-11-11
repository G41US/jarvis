#!/usr/bin/env bash
# Makes the Ubuntu inside Windows (WSL) a build machine for the phone app, so APKs build on your own laptop for free.
# Run it once inside Ubuntu:   bash /mnt/c/Users/<you>/Desktop/jarvis/wsl_runner.sh <TOKEN>
# TOKEN: github.com/G41US/jarvis > Settings > Actions > Runners > New self-hosted runner > Linux: the value after --token.
set -euo pipefail
TOKEN="${1:?Give the token from the New self-hosted runner page}"
REPO_URL="https://github.com/G41US/jarvis"
VER=2.330.0

echo "== tools the phone build uses (you'll be asked for your Ubuntu password once)"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git unzip zip binutils patchelf python3 python3-venv ca-certificates >/dev/null
# the build installs one package itself (patchelf); let it do that without a password, and nothing else
echo "$USER ALL=(root) NOPASSWD: /usr/bin/apt-get" | sudo tee /etc/sudoers.d/jarvis-runner >/dev/null && sudo chmod 440 /etc/sudoers.d/jarvis-runner

echo "== the GitHub runner"
mkdir -p ~/actions-runner && cd ~/actions-runner
if [ ! -f ./config.sh ]; then
  curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v$VER/actions-runner-linux-x64-$VER.tar.gz"
  tar xzf runner.tgz && rm runner.tgz
fi
./config.sh --url "$REPO_URL" --token "$TOKEN" --name jarvis-wsl --labels jarvis-linux --unattended --replace
sudo ./svc.sh install "$USER" && sudo ./svc.sh start

echo "== keep Ubuntu running in the background while Windows is on (a hidden task at sign-in)"
DISTRO="${WSL_DISTRO_NAME:-Ubuntu-24.04}"
schtasks.exe /Create /F /TN "Jarvis build machine" /SC ONLOGON /TR "powershell.exe -WindowStyle Hidden -Command wsl.exe -d $DISTRO -e sleep infinity" >/dev/null \
  && echo "sign-in task added" || echo "Couldn't add the sign-in task: keep an Ubuntu window open while building."
powershell.exe -WindowStyle Hidden -Command "Start-Process wsl.exe -ArgumentList '-d','$DISTRO','-e','sleep','infinity' -WindowStyle Hidden" || true

echo
echo "Done. github.com/G41US/jarvis > Settings > Actions > Runners should now list 'jarvis-wsl' as Idle."

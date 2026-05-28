# Setting up a BadCoin Pool from Scratch

A practical guide to standing up a Yescrypt pool for BadCoin, with browser-mining (wss://) support built in from day one.

This is the fallback plan if the canonical pool (run by Joel at pool.badcoin.dev) does not add wss:// support. The preferred path is documented in [`WSS_GATEWAY_REQUEST.md`](WSS_GATEWAY_REQUEST.md). Run your own pool only if that conversation does not land.

**Scope:** small community-scale pool. Single VPS. Yescrypt only. Hobbyist-grade ops. Not designed to compete with large multi-algo pools.

**Effort:** half a day to a full day from blank VPS to first share processed, assuming Linux comfort.

**Cost:** $20 to $50 per month, all-in.

---

## 1. What you are building

Six components glued together. You will end up with all of them running on one VPS unless you choose to split.

| Component | Purpose | What you install |
|---|---|---|
| **Coin daemon** | Full BadCoin node. Talks to the network, validates blocks, hands out block templates via RPC. | `badcoind` |
| **Stratum daemon** | Accepts miner TCP connections. Distributes work. Validates submitted shares. Submits found blocks to the daemon. | `yiimp/stratum` |
| **Payouts engine** | Calculates miner balances and sends payments. | yiimp's `payouts` cron |
| **Web frontend** | Pool homepage, miner dashboards, payout history, stats. | yiimp's PHP web app |
| **Database** | Persistent storage for miner accounts, shares, payouts, blocks. | MariaDB (yiimp default) |
| **Reverse proxy + TLS** | Terminates HTTPS for the web frontend and wss:// for the stratum WebSocket. | Caddy (or nginx) |

Plus the piece that makes browser mining work:

| Component | Purpose | What you install |
|---|---|---|
| **wss:// gateway** | Lets browsers connect to the pool via WebSocket. Translates wss:// connections to local TCP stratum. | `websockify` |

---

## 2. Hardware and cost

| Item | Specification | Approximate cost |
|---|---|---|
| VPS | 4 vCPU, 8 GB RAM, 100 GB SSD, Ubuntu 22.04 LTS | $20 to $40 / month (Hetzner, OVH, DigitalOcean) |
| Domain | Subdomain of badcoin.dev (e.g. `mypool.badcoin.dev`), or a separate domain | $10 / year if separate; $0 if subdomain |
| TLS cert | Let's Encrypt | Free |
| BAD seed capital | Cover the first payout cycles before fees accumulate | A few hundred BAD; recoverable from pool fees |

Total: **about $30 / month** for a real working pool.

Bandwidth is effectively free at this scale. Stratum messages are small JSON; even a few hundred miners produce a few MB per day.

---

## 3. Prerequisites

- A VPS provider account (Hetzner / OVH / DigitalOcean recommended; avoid US providers that disallow crypto)
- A domain you control with DNS access
- SSH client on your local machine
- The willingness to put 2 to 5 hours / week into ongoing operations once it is live

---

## 4. Provision the VPS

1. Create an Ubuntu 22.04 LTS instance (4 vCPU, 8 GB RAM, 100 GB SSD).
2. Point a DNS A record from your hostname (e.g. `mypool.badcoin.dev`) to the VPS public IP. Wait for propagation (usually minutes).
3. SSH in as root, create a non-root user with sudo, and disable root SSH:

```bash
adduser pool
usermod -aG sudo pool
mkdir /home/pool/.ssh
# Copy your authorized_keys in:
cp ~/.ssh/authorized_keys /home/pool/.ssh/
chown -R pool:pool /home/pool/.ssh
chmod 700 /home/pool/.ssh
chmod 600 /home/pool/.ssh/authorized_keys
# Disable root SSH and password auth:
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart sshd
```

4. From a second SSH session, confirm you can log in as `pool` with sudo, then close the root session.

5. Basic firewall:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp comment "ssh"
sudo ufw allow 80/tcp comment "http (Let's Encrypt + Caddy)"
sudo ufw allow 443/tcp comment "https (web frontend)"
sudo ufw allow 3333/tcp comment "stratum (native miners)"
sudo ufw allow 8443/tcp comment "stratum (wss:// for browser miners)"
sudo ufw allow 19012/tcp comment "badcoind p2p"
sudo ufw enable
```

---

## 5. Install badcoind

This is your full BadCoin node. The pool reads block templates from it and submits found blocks through it.

Two options:

### Option A: Build from source (recommended if you also do BadCoin Core work)

The recipe is exactly what's in [`badcoin-project/badcoin`](https://github.com/badcoin-project/badcoin), the same path documented in the BadCoin workspace's `docs/node-core-wallet-build.md`. Builds reliably on Ubuntu 22.04 LTS.

### Option B: Binary release

Get the latest release from [`badcoin-project/badcoin/releases`](https://github.com/badcoin-project/badcoin/releases). Extract and place `badcoind` and `badcoin-cli` in `/usr/local/bin/`.

Then configure:

```bash
mkdir -p ~/.badcoin
cat > ~/.badcoin/badcoin.conf <<EOF
daemon=1
server=1
listen=1
txindex=1
rpcuser=poolrpc
rpcpassword=$(openssl rand -base64 24)
rpcallowip=127.0.0.1
rpcport=9088
port=19012
addnode=<SEED_PEER_IP>:19012   # Ask in the BadCoin community for a current seed peer; DNS seeds also auto-discover.
EOF
chmod 600 ~/.badcoin/badcoin.conf
```

(Save the generated `rpcpassword` somewhere; you will need it for yiimp.)

Start the daemon:

```bash
badcoind
```

Initial sync from scratch takes hours. Monitor progress:

```bash
badcoin-cli getblockchaininfo | grep -E "(blocks|headers|verificationprogress)"
```

Wait for `verificationprogress` to be `0.999...` before continuing. (You can install the rest of the stack in parallel while it syncs.)

Make it a systemd service so it survives reboots:

```bash
sudo tee /etc/systemd/system/badcoind.service <<EOF
[Unit]
Description=BadCoin Daemon
After=network.target

[Service]
User=pool
ExecStart=/usr/local/bin/badcoind -conf=/home/pool/.badcoin/badcoin.conf
ExecStop=/usr/local/bin/badcoin-cli stop
Restart=on-failure
RestartSec=10s
Type=forking

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable badcoind
```

---

## 6. Install MariaDB

```bash
sudo apt update
sudo apt install -y mariadb-server
sudo mysql_secure_installation
# Answer: Y to set root password, Y to remove anonymous users,
# Y to disallow remote root, Y to remove test database, Y to reload privileges.
```

Create the yiimp database and user:

```bash
sudo mysql -u root -p
```

```sql
CREATE DATABASE yiimp;
CREATE USER 'yiimp'@'localhost' IDENTIFIED BY 'CHANGE-ME-TO-A-STRONG-PASSWORD';
GRANT ALL PRIVILEGES ON yiimp.* TO 'yiimp'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Save the password somewhere safe.

---

## 7. Install PHP and nginx

yiimp's web frontend is PHP. Even if you serve via Caddy (recommended), nginx is needed to host PHP-FPM cleanly.

```bash
sudo apt install -y nginx php8.1-fpm php8.1-cli php8.1-mysql php8.1-curl php8.1-gd \
  php8.1-mbstring php8.1-xml php8.1-intl php8.1-gmp git build-essential autoconf \
  automake libtool pkg-config libssl-dev libboost-all-dev libgmp-dev \
  libcurl4-openssl-dev libjansson-dev libmariadb-dev
```

---

## 8. Clone and build yiimp

```bash
cd /opt
sudo git clone https://github.com/tpruvot/yiimp.git
sudo chown -R pool:pool yiimp
cd yiimp
```

Build the stratum daemon:

```bash
cd /opt/yiimp/stratum
./build.sh
# This compiles the stratum C++ daemon. Takes a few minutes.
# If it fails, missing-dep messages are usually clear; install the package and re-run.
```

Build the blocknotify helper:

```bash
cd /opt/yiimp/blocknotify
make
```

---

## 9. Configure yiimp database

Load the schema:

```bash
mysql -u yiimp -p yiimp < /opt/yiimp/sql/2017-09-12-yiimp.sql
# Plus any other migration SQL files in /opt/yiimp/sql/ in date order.
ls /opt/yiimp/sql/
```

Apply each migration SQL file in chronological order if there are multiple.

Add BadCoin as a coin in the database (insert a row in the `coins` table). You can do this through the yiimp admin web UI later, but for first boot it is faster via SQL:

```sql
USE yiimp;
INSERT INTO coins (
  name, symbol, algo, master_wallet, rpcencoding,
  rpcuser, rpcpasswd, rpcport, rpchost, enable, auto_ready
) VALUES (
  'BadCoin', 'BAD', 'yescrypt', '<YOUR_BAD_POOL_PAYOUT_ADDRESS>', 'POW',
  'poolrpc', '<RPC_PASSWORD_FROM_STEP_5>', 9088, '127.0.0.1', 1, 1
);
```

Replace `<YOUR_BAD_POOL_PAYOUT_ADDRESS>` with a B... address you control (where the pool's fee accumulates). Replace `<RPC_PASSWORD_FROM_STEP_5>` with the password from your `badcoin.conf`.

---

## 10. Configure stratum

yiimp's stratum config file goes per-algo, not per-coin. Create `/opt/yiimp/stratum/config/yescrypt.conf`:

```ini
[TCP]
server = 0.0.0.0
port = 3333
password = tu5t8wfX2gJ # not used; legacy field
log_level = 2

[SQL]
host = 127.0.0.1
database = yiimp
username = yiimp
password = <YIIMP_DB_PASSWORD>
port = 3306

[STRATUM]
algo = yescrypt
difficulty = 0.001
max_ttf = 100000000

[WALLETS]
notify = http://127.0.0.1/notify.php
```

Then start the stratum daemon:

```bash
cd /opt/yiimp/stratum
./run.sh yescrypt
# Or set up as a systemd service (see next step)
```

### Systemd unit for stratum

```ini
# /etc/systemd/system/yiimp-stratum-yescrypt.service
[Unit]
Description=yiimp stratum daemon (Yescrypt)
After=network.target mariadb.service badcoind.service

[Service]
Type=simple
User=pool
WorkingDirectory=/opt/yiimp/stratum
ExecStart=/opt/yiimp/stratum/stratum config/yescrypt.conf
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now yiimp-stratum-yescrypt
sudo systemctl status yiimp-stratum-yescrypt
```

---

## 11. Configure the web frontend

Copy yiimp's web files into nginx's serving path:

```bash
sudo mkdir -p /var/www/yiimp
sudo cp -r /opt/yiimp/web/* /var/www/yiimp/
sudo chown -R www-data:www-data /var/www/yiimp
```

Edit `/var/www/yiimp/yaamp/core/config.php` with your database password, pool name, and admin email.

nginx site config at `/etc/nginx/sites-available/yiimp`:

```nginx
server {
    listen 8080;  # Caddy will proxy to this
    server_name _;
    root /var/www/yiimp;
    index index.php;

    location / {
        try_files $uri $uri/ /index.php?$args;
    }

    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.1-fpm.sock;
    }

    location ~ /\.ht {
        deny all;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/yiimp /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 12. Reverse proxy with TLS via Caddy

Caddy makes TLS automatic. Install:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Caddyfile at `/etc/caddy/Caddyfile`:

```caddy
mypool.badcoin.dev {
    # Web frontend
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

Caddy fetches a Let's Encrypt cert automatically on first request. Visit `https://mypool.badcoin.dev` in a browser; the yiimp homepage should appear.

---

## 13. Add the wss:// gateway for browser miners

This is the piece that makes the BadCoin HTML Miner work against your pool. The full recipe is in [`WSS_GATEWAY_REQUEST.md`](WSS_GATEWAY_REQUEST.md). Short version:

```bash
sudo apt install -y python3-pip
sudo pip3 install websockify
```

systemd unit at `/etc/systemd/system/wss-stratum.service`:

```ini
[Unit]
Description=WebSocket-to-TCP gateway for stratum
After=network.target yiimp-stratum-yescrypt.service

[Service]
Type=simple
User=nobody
Group=nogroup
ExecStart=/usr/local/bin/websockify \
  --cert=/etc/letsencrypt/live/mypool.badcoin.dev/fullchain.pem \
  --key=/etc/letsencrypt/live/mypool.badcoin.dev/privkey.pem \
  8443 127.0.0.1:3333
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

Note: Caddy provisions the cert at a path you can verify with `ls /var/lib/caddy/.local/share/caddy/certificates/`. The path above assumes you also ran certbot. If you only have Caddy's cert, point the unit at Caddy's cert path. Alternative: terminate TLS in Caddy itself by adding a wss reverse proxy:

```caddy
mypool.badcoin.dev:8443 {
    reverse_proxy 127.0.0.1:3333
}
```

(Caddy supports raw stream proxying. This is the cleaner approach if you are already using Caddy for TLS.)

Then enable and test:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wss-stratum
```

Test with the HTML miner: edit the Pool URL field to `wss://mypool.badcoin.dev:8443` and click Start. Within a few seconds the event log should show subscribe → authorize → first job.

---

## 14. Payouts

yiimp ships a payouts daemon. Add to cron:

```bash
crontab -e
```

```
*/5 * * * * php /var/www/yiimp/yaamp/core/cron.php
*/5 * * * * php /var/www/yiimp/yaamp/core/cron2.php
0 */1 * * * php /var/www/yiimp/yaamp/core/payouts.php
```

These three cover share accounting, block notifications, and payouts. Adjust the payouts frequency to your liking. Defaults are conservative.

You can also drive payouts on blockfound events by adding `blocknotify=/path/to/blocknotify command` to `badcoin.conf`.

---

## 15. First miner

Point your CPU miner at the pool:

```bash
cpuminer -a yescrypt -o stratum+tcp://mypool.badcoin.dev:3333 \
  -u B<your_payout_address>.worker1 -p x
```

Or use the BadCoin Core wallet's Mining tab (which speaks stratum natively) or `cgminer` / `sgminer` variants that support yescrypt.

Or use the HTML miner against your wss:// endpoint as soon as it's running.

Within minutes you should see shares accumulating in the yiimp dashboard.

---

## 16. Monitoring

Minimum viable monitoring:

```bash
# Stratum daemon alive?
systemctl status yiimp-stratum-yescrypt

# badcoind synced and accepting RPC?
badcoin-cli getblockchaininfo | jq '.blocks, .verificationprogress'

# Recent shares in DB?
mysql -u yiimp -p yiimp -e "SELECT count(*) FROM shares WHERE time > UNIX_TIMESTAMP() - 3600;"

# Active miner connections?
ss -tn 'sport = :3333' | wc -l
```

Wire these into a simple cron that emails you if anything looks wrong. For a hobby-scale pool, that is enough. Don't over-build monitoring before you have the pool running stably for a few weeks.

Optional: install Netdata for a free dashboard.

```bash
bash <(curl -Ss https://my-netdata.io/kickstart.sh)
```

Visit `http://your-vps-ip:19999`.

---

## 17. Backups

You need to back up two things:

1. **The pool database** (`yiimp` in MariaDB). Daily mysqldump to off-server storage.
2. **The pool's hot wallet** (the BadCoin address you set as `master_wallet`). Standard wallet backup applies; encrypt and store off-box.

```bash
# Daily DB backup script (add to root cron):
0 3 * * * mysqldump -u yiimp -p<password> yiimp | gzip > /backup/yiimp-$(date +\%F).sql.gz
```

Document the wallet recovery procedure in a runbook before you accept your first miner. Treat it the way the BadCoin Exchange treats reconciliation: assume something will go wrong, and have the recovery path written down in advance.

---

## 18. Ongoing operational checklist

Weekly:

- [ ] Confirm badcoind is synced (height matches `explorer.badcoin.dev`).
- [ ] Confirm stratum daemon is running and accepting connections.
- [ ] Confirm payouts are processing (no miners with stuck balances).
- [ ] Confirm hot wallet has enough BAD for the next payout cycle.

Monthly:

- [ ] Run `apt update && apt upgrade` for security patches.
- [ ] Verify backup restore drill (restore yesterday's dump to a scratch DB, confirm it loads).
- [ ] Review pool stats: hashrate trends, miner count, blocks found vs network share.

Per incident:

- [ ] If badcoind crashes: check disk, check logs, restart, verify it re-syncs.
- [ ] If stratum crashes: restart, check why (logs in `/opt/yiimp/stratum/stratum.log`).
- [ ] If payouts fail: pause the cron, investigate, manual payouts if needed.
- [ ] If a miner reports incorrect payout: pull their share history, compare to expected, refund if our error.

---

## 19. Common pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| yiimp web frontend shows "Database connection failed" | Wrong DB credentials in `config.php` | Re-check, restart php-fpm |
| Stratum connects but never gets jobs | badcoind not synced, or wrong RPC password | Wait for sync; verify `badcoin-cli getblockcount` works |
| Stratum daemon eats 100% CPU | Algo plugin misbuilt or wrong version | Rebuild yiimp's stratum from source for your specific yescrypt variant |
| wss:// works locally but not from the public internet | Firewall blocking port 8443 | `sudo ufw allow 8443/tcp` |
| Miners connect but report 0 H/s | Difficulty too high; lower `STRATUM/difficulty` in yescrypt.conf | Start at 0.001 for hobbyist miners |
| Payouts fail with "insufficient funds" | Hot wallet empty | Top up from cold wallet; investigate why fee accumulation didn't cover payouts |
| Let's Encrypt cert expired | Renewal hook failed | Manually renew with `certbot renew --force-renewal`, then debug the hook |

---

## 20. Compared to working with the canonical pool

This is significant ongoing work. If Joel's pool (per [`WSS_GATEWAY_REQUEST.md`](WSS_GATEWAY_REQUEST.md)) is open to adding wss:// support, that is the better path:

- The community keeps one canonical pool, which means more concentrated hashrate, more reliable block finding, and more predictable payouts for miners.
- You avoid the 2 to 5 hours / week of ongoing pool ops.
- You stay focused on the wallet, exchange, and HTML miner work that is currently in flight.

Standing up a competing pool fragments the hashrate. For a small community coin, that hurts everyone slightly. Do it only if the canonical pool will not add wss:// support and you really want to enable browser mining.

If you do go forward: name your pool clearly as complementary (e.g. "BadCoin Browser Mining Pool" or "BadCoin Hobby Pool"), publish your operator identity openly, and commit to a public shutdown procedure if you ever step away.

---

## 21. Where this guide came from

This is the recipe the BadCoin community would need to run if the canonical pool does not add wss:// support and someone wants to make browser mining real for the community. It is written so a non-expert with Linux comfort can follow it end to end in a day.

The original ask, [`WSS_GATEWAY_REQUEST.md`](WSS_GATEWAY_REQUEST.md), is the path of least resistance. This guide is the fallback. Read both before deciding which path to take.

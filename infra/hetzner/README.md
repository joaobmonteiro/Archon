# Archon on Hetzner Cloud

Terraform module that provisions a single-node Archon deploy on Hetzner Cloud:

- **CPX32** (4 vCPU, 8 GB RAM, 160 GB NVMe, 20 TB traffic) in Nuremberg
- **50 GB Hetzner Volume** mounted at `/mnt/archon-data` (survives server rebuilds)
- **Hetzner Cloud Firewall** gating SSH + HTTP + HTTPS + HTTP/3
- **Cloudflare DNS** A record (gray-cloud; Caddy does TLS directly via Let's Encrypt)
- **cloud-init** that installs Docker, mounts the volume, clones the Archon repo, and pre-pulls the image
- **CI deploy SSH key** auto-generated for the GitHub Actions deploy workflow

All in, **~€19/mo** (vs ~€145/mo for the AWS equivalent in `infra/`).

See the design doc at `~/.claude/plans/in-want-to-deploy-jazzy-hartmanis.md` for the full rationale.

## Prerequisites

1. A **Hetzner Cloud project** with an API token.
2. A domain in **Cloudflare** with the Zone ID (Dashboard → Overview → API).
3. A **Cloudflare API token** scoped to `DNS → Edit` for that zone.
4. Your **SSH public key** ready to paste.
5. **Terraform ≥ 1.6**.

## Apply

```bash
cd infra/hetzner

cp terraform.tfvars.example terraform.tfvars
$EDITOR terraform.tfvars           # fill in domain, zone id, ssh pubkey, admin_cidrs

export HCLOUD_TOKEN=...            # hetzner cloud API token
export CLOUDFLARE_API_TOKEN=...    # cloudflare DNS token

terraform init
terraform plan
terraform apply
```

Apply takes ~3 minutes (server provisioning) + ~5 minutes of cloud-init (Docker install, volume mount, image pull). Watch cloud-init progress:

```bash
ssh archon@$(terraform output -raw server_ipv4) sudo tail -f /var/log/cloud-init-output.log
```

## First boot: secrets

Terraform seeds `/mnt/archon-data/.env` with non-secret defaults (domain, ACME email, Postgres URL). You fill in the AI + platform tokens manually:

```bash
IP=$(terraform output -raw server_ipv4)
ssh archon@$IP sudo -u archon vi /mnt/archon-data/.env
```

Minimum required keys:

- `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`)
- At least one platform token (`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `GITHUB_TOKEN`, `LINEAR_API_KEY`, etc.)

## First boot: start the stack

```bash
ssh archon@$IP "cd /opt/archon && docker compose --profile with-db --profile cloud up -d"

# wait ~60s for Caddy to provision the Let's Encrypt cert
curl -I https://$(terraform output -raw fqdn)/api/health
```

You should see `HTTP/2 200` with a valid Let's Encrypt certificate.

## GitHub Actions auto-deploy

The workflow at `.github/workflows/deploy-vps.yml` redeploys the server on every successful GHCR publish.

1. **VPS_HOST** — from Terraform output:
   ```bash
   terraform output -raw server_ipv4
   ```
2. **VPS_SSH_KEY** — sensitive output:
   ```bash
   terraform output -raw ssh_deploy_private_key
   ```
3. Paste both into GitHub **Settings → Secrets and variables → Actions**.

From then on, every release tag that triggers `.github/workflows/publish.yml` will in turn trigger `deploy-vps.yml` about 2 minutes later and the container on the VPS will roll forward.

## Day-2 operations

| What | How |
|---|---|
| Change server size | Edit `server_type` in `terraform.tfvars`, `terraform apply`. Hetzner does the resize in place; ~2 min downtime. |
| Resize the volume | Edit `volume_size`, `terraform apply`. Online expansion — then from the server: `sudo resize2fs /dev/disk/by-id/scsi-0HC_Volume_<id>`. |
| Destroy | `terraform destroy`. The Hetzner volume has `prevent_destroy` disabled for testing — enable it in `server.tf` before real production. |
| Deploy manually | `ssh archon@<ip>; cd /opt/archon; docker compose --profile with-db --profile cloud pull && up -d` |
| Tail logs | `ssh archon@<ip> 'cd /opt/archon && docker compose logs -f app'` |

## Backups

- **Hetzner snapshots** — enable via the Hetzner console (or add `backups = true` on `hcloud_server` — ~20% of server price for weekly backups). Per-volume snapshots also available.
- **Offsite (recommended for real use)** — a small cron job on the server shipping `pg_dump | restic → Backblaze B2`. Out of scope for this module.

## Cost (monthly, EUR)

| Component | €/mo |
|---|---|
| CPX32 server (Nuremberg) | 13.99 |
| Hetzner Volume (50 GB) | 2.00 |
| Hetzner snapshots (optional, ~20%) | 2.80 |
| Cloudflare DNS | 0 |
| GHCR image storage | 0 |
| **Total (with backups)** | **~19** |

## Known limits

- **Single AZ / single server.** If Nuremberg has an outage, you're down until they fix it. Per the design doc, that's accepted for a team-of-6 testing tier.
- **Telegram long-polling.** Archon's Telegram adapter polls and would duplicate across multiple servers. Single-instance avoids it — don't duplicate this module without adding a lock.
- **`admin_cidrs` default is `0.0.0.0/0`.** Change it before real use; SSH brute-force is real.
- **Cloudflare is unproxied (gray cloud).** Caddy handles TLS directly. Switching to proxied requires Full (strict) mode + origin certs in Caddyfile.

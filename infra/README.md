# Archon AWS Infrastructure

Terraform for deploying Archon as a single-AZ cloud service: ECS-on-EC2 + Aurora Serverless v2 Postgres + EBS + ALB + CloudWatch.

**Defaults are sized for a testing tier** (~2–4 concurrent workflows). To scale up to production (~60 concurrent, 6 engineers), bump the variables noted in `terraform.tfvars.example`. See `/home/joao/.claude/plans/in-want-to-deploy-jazzy-hartmanis.md` for the production sizing rationale.

## What gets created

```
VPC (2 public + 2 private subnets across 2 AZs)
 ├── ALB (HTTPS :443, HTTP :80 redirect, 300s idle timeout for SSE)
 ├── ECS cluster (EC2 capacity provider, 1 host in primary AZ)
 │    └── ECS service × 1 task
 │         └── Archon container (bridge net, :3090)
 │              └── /home/appuser/.archon ← bind-mount /mnt/archon
 ├── EC2 host (t3.large by default — testing tier)
 │    └── EBS gp3 50 GB, reattached on boot via user-data
 ├── Aurora Serverless v2 Postgres (0.5–1 ACU — testing tier)
 ├── Secrets Manager entries (one per API key, + DATABASE_URL, + db master)
 └── CloudWatch log group + alarms
```

## Pre-flight checklist

Before `terraform apply`, you need:

1. **AWS account + credentials** with IAM/EC2/RDS/ECS/ALB permissions in the target region.
2. **An ACM certificate** in the same region as the ALB, validated. DNS validation via Route 53 is easiest.
3. **An ECR repository** plus a pushed Archon image. Build the image from this repo's `Dockerfile`, plus a small overlay that installs the Claude Code CLI and drops the Codex binary at `/home/appuser/.archon/vendor/codex/`:
   ```dockerfile
   FROM <your-archon-base>:latest
   USER root
   RUN curl -fsSL https://claude.ai/install.sh | bash   # or: npm i -g @anthropic-ai/claude-code
   COPY codex /usr/local/bin/codex
   RUN chmod +x /usr/local/bin/codex
   USER appuser
   ```
   Push to ECR and take note of the image URI.
4. **(Optional) An S3 bucket + DynamoDB table** if you want remote Terraform state — add a `backend "s3"` block in `versions.tf`. Local state is fine to start.

## Deploy

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars — set acm_certificate_arn, archon_image_uri, aws_region

terraform init
terraform plan
terraform apply
```

Apply takes ~15 minutes (Aurora is the long pole).

## Post-apply: populate secrets

The task-definition pulls API keys from Secrets Manager at start. Terraform creates the entries as placeholders; fill the real values once:

```bash
# Get the list
terraform output -json app_secret_names | jq -r '.[]'

# Set each one
aws secretsmanager put-secret-value \
  --secret-id archon/app/ANTHROPIC_API_KEY \
  --secret-string 'sk-ant-...'

aws secretsmanager put-secret-value \
  --secret-id archon/app/GITHUB_TOKEN \
  --secret-string 'ghp_...'
# ...repeat for the integrations you use
```

Then force a redeploy so the task picks up the new values:

```bash
aws ecs update-service \
  --cluster "$(terraform output -raw ecs_cluster_name)" \
  --service "$(terraform output -raw ecs_service_name)" \
  --force-new-deployment
```

## Post-apply: DNS

Point a Route 53 ALIAS (or CNAME on an external DNS) at `alb_dns_name` using `alb_zone_id`:

```hcl
resource "aws_route53_record" "archon" {
  zone_id = "ZXXXXXXXXXXXXX"
  name    = "archon.internal.example.com"
  type    = "A"
  alias {
    name                   = module.archon.alb_dns_name      # or the raw output
    zone_id                = module.archon.alb_zone_id
    evaluate_target_health = true
  }
}
```

## Verifying the deploy

```bash
ALB=$(terraform output -raw alb_dns_name)

curl -fsS https://$ALB/health
curl -fsS https://$ALB/health/db
curl -fsS https://$ALB/health/concurrency   # expect { maxConcurrent: 4, active: 0, ... }
```

Follow the container logs:

```bash
aws logs tail "$(terraform output -raw log_group)" --follow
```

Shell into the host without SSH (Session Manager works via the instance profile):

```bash
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-instances \
  --query 'AutoScalingInstances[?AutoScalingGroupName==`archon-asg-xxxx`].InstanceId' \
  --output text)
aws ssm start-session --target "$INSTANCE_ID"
```

## Day-2 operations

**Deploy a new image**: push a new tag to ECR, update `archon_image_uri` in `terraform.tfvars`, `terraform apply`. The service replaces the running task. ~30s of downtime.

**Scale up memory**: change `ec2_instance_type` (and `container_memory_reservation_mb` to match). `terraform apply` replaces the EC2 instance; the EBS volume detaches from the old host and reattaches to the new one via user-data. Expect ~5 min of downtime.

**Resize the EBS volume**: increase `ebs_size_gb`. gp3 expands online:
```bash
sudo growpart /dev/nvme1n1 1   # if partitioned (ours isn't)
sudo resize2fs /dev/nvme1n1
```
Run from an SSM shell on the host.

**Rotate the DB password**: set a new value in `db_master_password`, then update `database_url`. Or use AWS RDS's managed rotation.

**Backups**: AWS Backup against tag `Project=archon` — daily EBS snapshots + Aurora automatic backups (7-day retention configured).

## Authentication (follow-up)

The ALB is intentionally **unauthenticated** out of the box so you can validate end-to-end plumbing first. Before putting real users on it, pick one:

- **ALB + Cognito OIDC** — add `authenticate_oidc` default_action on the HTTPS listener for non-`/webhooks/*` paths. Create a Cognito user pool + IdP (Google Workspace or GitHub) separately.
- **AWS WAF + IP allowlist** — cheapest, blocks everything except your office/VPN CIDRs. Webhook providers still need to be whitelisted.
- **Caddy sidecar with basic-auth** — simplest to stand up, single shared password. Matches the `deploy/Caddyfile` pattern already in the repo.

Webhook paths (`/webhooks/*`) should stay unauthenticated — Archon verifies HMAC signatures in-app.

## Costs (rough, eu-west-1, on-demand)

### Testing tier (current defaults)

| | /month |
|---|---|
| t3.large (730h) | ~$60 |
| EBS gp3 50 GB | ~$5 |
| EC2 root (20 GB gp3) | ~$2 |
| Aurora Serverless v2 (avg 0.5 ACU) | ~$50 |
| ALB | ~$20 + small LCU |
| CloudWatch Logs (~5 GB, 7d) | ~$3 |
| Secrets Manager (13 secrets) | ~$5 |
| NAT Gateway | $0 (none) |
| **Total** | **~$145/mo** |

### Production tier (after bumping variables)

With `r6i.4xlarge`, 200 GB EBS, `db_max_capacity = 4`, 30-day logs, Container Insights on: **~$880/mo**. Downsizing to `r6i.2xlarge` lands near $500/mo.

## Known gotchas

- **EBS volume is AZ-pinned.** If the primary AZ has an outage, the EC2 instance can't come back up until the AZ recovers (or you restore from snapshot in another AZ). This is the explicit tradeoff for a single-AZ setup.
- **ECS agent on AL2023 pulls images as root, then runs them as UID 1001.** The user-data chowns `/mnt/archon` to `1001:1001`. If you change the image's UID, update `ec2.tf`.
- **Aurora Postgres version** `16.4` is current as of this writing. Check AWS for the latest minor and bump `db_engine_version`.
- **Deletion**: `enable_deletion_protection = true` + `prevent_destroy` on the EBS volume means `terraform destroy` won't wipe data by accident. To fully tear down, unset both and re-apply first.

## File map

- `versions.tf` — terraform + provider pins
- `providers.tf` — AWS provider, default tags, data sources
- `variables.tf` — inputs
- `outputs.tf` — ALB DNS, RDS endpoint, secret names, etc.
- `vpc.tf` — VPC, subnets (2 public + 2 private), IGW, routes
- `security-groups.tf` — ALB / ECS / RDS SGs
- `iam.tf` — ECS execution role, ECS task role, EC2 instance profile
- `ebs.tf` — persistent data volume
- `ec2.tf` — launch template + ASG (1/1/1), user-data attaches EBS on boot
- `ecs.tf` — cluster, capacity provider, task def, service
- `alb.tf` — ALB + target group + listeners (HTTPS + HTTP→HTTPS redirect)
- `rds.tf` — Aurora Serverless v2 cluster + instance + DATABASE_URL secret
- `secrets.tf` — Secrets Manager placeholders for API keys
- `cloudwatch.tf` — log group + alarms

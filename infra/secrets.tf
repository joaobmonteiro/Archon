# Env vars that Archon consumes as secrets. These are created empty — populate
# them after `terraform apply` with:
#   aws secretsmanager put-secret-value --secret-id <name> --secret-string <value>
# ECS pulls them at task start and injects as env vars.
locals {
  app_secret_keys = toset([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
    "WEBHOOK_SECRET",
    "LINEAR_API_KEY",
    "LINEAR_WEBHOOK_SECRET",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "DISCORD_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_ALLOWED_USER_IDS",
  ])
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = local.app_secret_keys
  name                    = "${var.name_prefix}/app/${each.key}"
  recovery_window_in_days = 0
}

# Placeholder so ECS doesn't refuse to start the task before you've set real
# values. The task will start with REPLACE_ME env vars; the app may no-op on
# adapters whose tokens are invalid, which is fine. Replace these in the
# console or via CLI; `lifecycle.ignore_changes` keeps Terraform from
# clobbering your real values on subsequent applies.
resource "aws_secretsmanager_secret_version" "app_placeholder" {
  for_each      = aws_secretsmanager_secret.app
  secret_id     = each.value.id
  secret_string = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

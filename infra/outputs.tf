output "alb_dns_name" {
  description = "Point your DNS CNAME / ALIAS here."
  value       = aws_lb.archon.dns_name
}

output "alb_zone_id" {
  description = "Route 53 alias target zone id for the ALB."
  value       = aws_lb.archon.zone_id
}

output "aurora_endpoint" {
  description = "Aurora cluster writer endpoint."
  value       = aws_rds_cluster.aurora.endpoint
}

output "database_url_secret_arn" {
  description = "ARN of the DATABASE_URL secret consumed by the task."
  value       = aws_secretsmanager_secret.database_url.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.archon.name
}

output "ebs_volume_id" {
  value = aws_ebs_volume.archon.id
}

output "log_group" {
  value = aws_cloudwatch_log_group.archon.name
}

output "app_secret_names" {
  description = "Populate these after apply with `aws secretsmanager put-secret-value --secret-id <name> --secret-string <value>`."
  value       = sort([for s in aws_secretsmanager_secret.app : s.name])
}

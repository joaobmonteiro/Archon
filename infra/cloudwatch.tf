resource "aws_cloudwatch_log_group" "archon" {
  name              = "/ecs/${var.name_prefix}"
  retention_in_days = var.cloudwatch_log_retention_days
}

# Task count drop — requires Container Insights (disabled on the cluster for
# testing). The alarm is defined so it's ready to go once you re-enable
# insights, but stays silent when metrics are missing.
resource "aws_cloudwatch_metric_alarm" "task_not_running" {
  alarm_name          = "${var.name_prefix}-task-not-running"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  period              = 60
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  statistic           = "Average"
  threshold           = 1
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.archon.name
  }

  alarm_description = "Archon ECS task is not running (requires Container Insights enabled)."
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name_prefix}-alb-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  period              = 60
  metric_name         = "HTTPCode_ELB_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.archon.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_target_5xx" {
  alarm_name          = "${var.name_prefix}-target-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  period              = 60
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  statistic           = "Sum"
  threshold           = 10
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.archon.arn_suffix
    TargetGroup  = aws_lb_target_group.archon.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${var.name_prefix}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  period              = 300
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  statistic           = "Average"
  threshold           = 80
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = aws_rds_cluster.aurora.id
  }
}

resource "aws_cloudwatch_metric_alarm" "ec2_memory" {
  alarm_name          = "${var.name_prefix}-host-memory-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  period              = 300
  metric_name         = "MemoryReservation"
  namespace           = "AWS/ECS"
  statistic           = "Average"
  threshold           = 90
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
  }

  alarm_description = "ECS cluster memory reservation > 90% — scale up the instance."
}

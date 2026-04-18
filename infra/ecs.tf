resource "aws_ecs_cluster" "main" {
  name = "${var.name_prefix}-cluster"

  # Container Insights adds ~$2/task/month of CloudWatch metrics. Off for
  # testing — flip to "enabled" when you care about RunningTaskCount alarms.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_capacity_provider" "main" {
  name = "${var.name_prefix}-cp"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.ecs.arn
    managed_termination_protection = "DISABLED"

    # Singleton — no autoscaling, no managed draining.
    managed_scaling {
      status = "DISABLED"
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = [aws_ecs_capacity_provider.main.name]

  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.main.name
    weight            = 1
    base              = 1
  }
}

locals {
  # Secrets that are injected into the container as environment variables.
  container_secrets = concat(
    [
      {
        name      = "DATABASE_URL"
        valueFrom = aws_secretsmanager_secret.database_url.arn
      },
    ],
    [
      for k, s in aws_secretsmanager_secret.app : {
        name      = k
        valueFrom = s.arn
      }
    ],
  )

  container_environment = [
    { name = "PORT", value = tostring(var.app_port) },
    { name = "ARCHON_HOME", value = "/home/appuser/.archon" },
    { name = "MAX_CONCURRENT_CONVERSATIONS", value = tostring(var.max_concurrent_conversations) },
    { name = "LOG_LEVEL", value = "info" },
    { name = "CLEANUP_INTERVAL_HOURS", value = "6" },
    { name = "STALE_THRESHOLD_DAYS", value = "14" },
    { name = "SESSION_RETENTION_DAYS", value = "30" },
    { name = "CLAUDE_BIN_PATH", value = "/usr/local/bin/claude" },
    { name = "CODEX_BIN_PATH", value = "/home/appuser/.archon/vendor/codex/codex" },
    { name = "NODE_ENV", value = "production" },
  ]
}

resource "aws_ecs_task_definition" "archon" {
  family                   = "${var.name_prefix}-task"
  network_mode             = "bridge"
  requires_compatibilities = ["EC2"]
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  volume {
    name      = "archon-data"
    host_path = "/mnt/archon"
  }

  container_definitions = jsonencode([
    {
      name              = "archon"
      image             = var.archon_image_uri
      essential         = true
      memoryReservation = var.container_memory_reservation_mb

      portMappings = [
        {
          containerPort = var.app_port
          hostPort      = var.app_port
          protocol      = "tcp"
        },
      ]

      mountPoints = [
        {
          sourceVolume  = "archon-data"
          containerPath = "/home/appuser/.archon"
          readOnly      = false
        },
      ]

      environment = local.container_environment
      secrets     = local.container_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.archon.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "archon"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "curl -fs http://localhost:${var.app_port}/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 90
      }

      stopTimeout = 120
    },
  ])
}

resource "aws_ecs_service" "archon" {
  name            = var.name_prefix
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.archon.arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.main.name
    weight            = 1
    base              = 1
  }

  # Singleton: accept ~30s of downtime on deploy rather than trying to double-up.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  load_balancer {
    target_group_arn = aws_lb_target_group.archon.arn
    container_name   = "archon"
    container_port   = var.app_port
  }

  health_check_grace_period_seconds = 120

  depends_on = [
    aws_lb_listener.https,
    aws_ecs_cluster_capacity_providers.main,
  ]
}

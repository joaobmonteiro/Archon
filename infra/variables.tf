variable "aws_region" {
  type        = string
  description = "AWS region for all resources."
}

variable "environment" {
  type        = string
  description = "Environment tag (e.g. prod, staging)."
  default     = "prod"
}

variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names."
  default     = "archon"
}

# ---------- Networking ----------

variable "vpc_cidr" {
  type        = string
  description = "CIDR block for the VPC."
  default     = "10.30.0.0/16"
}

variable "alb_ingress_cidrs" {
  type        = list(string)
  description = "CIDRs allowed to hit the ALB on 443. Default is wide-open because webhook providers (GitHub/Linear/etc.) send from many IPs. Tighten for /* auth paths via WAF or listener rules."
  default     = ["0.0.0.0/0"]
}

variable "acm_certificate_arn" {
  type        = string
  description = "ARN of an ACM certificate in the same region as the ALB. Create separately (DNS validation on Route 53 is easiest)."
}

# ---------- Compute ----------

variable "ec2_instance_type" {
  type        = string
  description = "EC2 instance type for the ECS host. Default is testing-tier (~2-4 concurrent workflows). Bump to r6i.2xlarge/4xlarge for production scale."
  default     = "t3.large"
}

variable "container_memory_reservation_mb" {
  type        = number
  description = "Soft memory reservation for the Archon container (MB). Container can burst above this up to instance limit."
  default     = 6000
}

variable "app_port" {
  type        = number
  description = "TCP port the Archon server listens on inside the container."
  default     = 3090
}

variable "archon_image_uri" {
  type        = string
  description = "Full ECR image URI including tag (e.g. 123456789012.dkr.ecr.eu-west-1.amazonaws.com/archon:latest). Build and push before `terraform apply`."
}

variable "max_concurrent_conversations" {
  type        = number
  description = "Value for MAX_CONCURRENT_CONVERSATIONS env var. Testing default is low; raise to ~64 for production scale."
  default     = 4
}

# ---------- Storage ----------

variable "ebs_size_gb" {
  type        = number
  description = "Size of the persistent EBS volume mounted at /mnt/archon. Testing default is small; bump to 200 for production."
  default     = 50
}

variable "ebs_iops" {
  type        = number
  description = "Provisioned IOPS for the gp3 volume."
  default     = 3000
}

variable "ebs_throughput" {
  type        = number
  description = "Provisioned throughput (MiB/s) for the gp3 volume."
  default     = 125
}

# ---------- Database ----------

variable "db_name" {
  type        = string
  default     = "archon"
}

variable "db_master_username" {
  type        = string
  default     = "archon"
}

variable "db_min_capacity" {
  type        = number
  description = "Aurora Serverless v2 min ACU."
  default     = 0.5
}

variable "db_max_capacity" {
  type        = number
  description = "Aurora Serverless v2 max ACU. Testing default is small; raise to 4 for production."
  default     = 1
}

variable "db_engine_version" {
  type        = string
  description = "Aurora Postgres engine version. Archon needs >= 13 (for gen_random_uuid / JSONB)."
  default     = "16.4"
}

# ---------- Operations ----------

variable "cloudwatch_log_retention_days" {
  type        = number
  default     = 7
}

variable "enable_deletion_protection" {
  type        = bool
  description = "Enables deletion protection on ALB and RDS, and skip_final_snapshot=false on the Aurora cluster. Set to true for production."
  default     = false
}

variable "ec2_key_pair_name" {
  type        = string
  description = "Optional EC2 key pair name for break-glass SSH. Prefer SSM Session Manager (already enabled via instance profile)."
  default     = null
}

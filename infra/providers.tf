provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "archon"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

provider "aws" {
  region = var.region
}

locals {
  name = var.name
  tags = merge(var.tags, {
    Project = "clawreview"
    Managed = "terraform"
  })
}

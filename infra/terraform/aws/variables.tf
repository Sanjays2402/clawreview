variable "region" {
  type    = string
  default = "us-west-2"
}

variable "name" {
  type    = string
  default = "clawreview"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "azs" {
  type    = list(string)
  default = ["us-west-2a", "us-west-2b"]
}

variable "db_username" {
  type    = string
  default = "clawreview"
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "image_server" {
  type    = string
  default = "ghcr.io/sanjays2402/clawreview-server:latest"
}

variable "image_dashboard" {
  type    = string
  default = "ghcr.io/sanjays2402/clawreview-dashboard:latest"
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "image_ref" {
  description = "Immutable VRRelay OCI image reference, for example ghcr.io/tdeverx/vrrelay@sha256:<digest>."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-fA-F]{64}$", var.image_ref))
    error_message = "image_ref must be pinned by digest."
  }
}

variable "mediamtx_image_ref" {
  description = "Immutable MediaMTX OCI image reference used by ingest-origin and edge nodes."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-fA-F]{64}$", var.mediamtx_image_ref))
    error_message = "mediamtx_image_ref must be pinned by digest."
  }
}

variable "postgres_url" {
  description = "Externally managed PostgreSQL connection URL."
  type        = string
  sensitive   = true
}

variable "valkey_url" {
  description = "Externally managed Valkey connection URL."
  type        = string
  sensitive   = true
}

variable "master_key" {
  description = "Per-node encrypted-file secret-store master key."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.master_key) >= 24
    error_message = "master_key must contain at least 24 characters."
  }
}

variable "media_mtx_read_token" {
  description = "Shared MediaMTX reader token."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.media_mtx_read_token) >= 32
    error_message = "media_mtx_read_token must contain at least 32 characters."
  }
}

variable "trusted_proxy_cidrs" {
  description = "Comma-separated CIDR ranges for the role's trusted TLS proxy sources."
  type        = string

  validation {
    condition     = length(trimspace(var.trusted_proxy_cidrs)) > 0
    error_message = "trusted_proxy_cidrs must be explicit and nonempty."
  }
}

variable "object_store_env" {
  description = "Object-store environment variables, for example S3, Azure Blob, or GCS settings."
  type        = map(string)
  sensitive   = true

  validation {
    condition = alltrue([
      contains(keys(var.object_store_env), "VRRELAY_OBJECT_STORE_DRIVER"),
      contains(keys(var.object_store_env), "VRRELAY_OBJECT_STORE_BUCKET")
    ])
    error_message = "object_store_env must include VRRELAY_OBJECT_STORE_DRIVER and VRRELAY_OBJECT_STORE_BUCKET."
  }
}

variable "common_env" {
  description = "Additional environment variables shared by every rendered node."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "nodes" {
  description = "Role-specific VM definitions. Each entry renders one cloud-init document."
  type = map(object({
    role                      = string
    node_id                   = optional(string, "")
    name                      = string
    region                    = string
    public_url                = string
    setup_token               = optional(string, "")
    agent_tls_names           = optional(string, "")
    controller_agent_url      = optional(string, "")
    controller_enrollment_url = optional(string, "")
    join_token                = optional(string, "")
    live_origin_url           = optional(string, "")
    live_srt_passphrase       = optional(string, "")
    webrtc_additional_hosts   = optional(string, "")
    metrics_token             = optional(string, "")
    extra_env                 = optional(map(string), {})
  }))
  sensitive = true

  validation {
    condition = alltrue([
      for node in values(var.nodes) : contains(["controller", "source-worker", "ingest-origin", "edge"], node.role)
    ])
    error_message = "Each node role must be one of controller, source-worker, ingest-origin, or edge."
  }

  validation {
    condition = alltrue([
      for node in values(var.nodes) : startswith(node.public_url, "https://")
    ])
    error_message = "Every VM node public_url must use HTTPS for production."
  }

  validation {
    condition = alltrue([
      for node in values(var.nodes) : node.role != "controller" || length(node.setup_token) >= 32
    ])
    error_message = "Controller nodes must include a first-run setup_token with at least 32 characters."
  }

  validation {
    condition = alltrue([
      for node in values(var.nodes) : node.role != "controller" || length(node.agent_tls_names) > 0
    ])
    error_message = "Controller nodes must include agent_tls_names for the mTLS listener."
  }

  validation {
    condition = alltrue([
      for node in values(var.nodes) : node.role == "controller" || length(node.join_token) >= 32
    ])
    error_message = "Non-controller nodes must include their single-use join_token."
  }

  validation {
    condition = alltrue([
      for node in values(var.nodes) :
      node.role == "controller" ||
      (startswith(node.controller_agent_url, "wss://") && startswith(node.controller_enrollment_url, "https://"))
    ])
    error_message = "Non-controller nodes must use WSS controller_agent_url and HTTPS controller_enrollment_url."
  }

  validation {
    condition = alltrue([
      for node in values(var.nodes) :
      node.role != "edge" ||
      startswith(node.live_origin_url, "srt://") ||
      startswith(node.live_origin_url, "rtsp://")
    ])
    error_message = "Edge nodes must include a live_origin_url using srt:// or rtsp://."
  }

  validation {
    condition = alltrue([
      for node in values(var.nodes) :
      node.live_srt_passphrase == "" ||
      (length(node.live_srt_passphrase) >= 10 && length(node.live_srt_passphrase) <= 79)
    ])
    error_message = "live_srt_passphrase must be empty or 10-79 characters."
  }
}

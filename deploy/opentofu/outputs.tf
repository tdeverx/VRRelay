output "cloud_init_user_data" {
  description = "Rendered cloud-init user-data per supplied VM. Treat as sensitive because it contains bootstrap secrets."
  sensitive   = true
  value = {
    for node_key, node in var.nodes : node_key => templatefile("${path.module}/../cloud-init/vrrelay-node.yaml", {
      image_ref          = var.image_ref
      mediamtx_image_ref = var.mediamtx_image_ref
      role_profile       = node.role
      runtime_env        = local.runtime_env[node_key]
      mediamtx_env       = local.mediamtx_env[node_key]
      relay_ports_block  = local.relay_ports_block[node.role]
      enable_origin      = node.role == "ingest-origin"
      enable_edge        = node.role == "edge"
    })
  }
}

output "cloud_init_sha256" {
  description = "Non-secret checksum of each rendered cloud-init document for retained deployment evidence."
  value = nonsensitive({
    for node_key, node in var.nodes : node_key => sha256(templatefile("${path.module}/../cloud-init/vrrelay-node.yaml", {
      image_ref          = var.image_ref
      mediamtx_image_ref = var.mediamtx_image_ref
      role_profile       = node.role
      runtime_env        = local.runtime_env[node_key]
      mediamtx_env       = local.mediamtx_env[node_key]
      relay_ports_block  = local.relay_ports_block[node.role]
      enable_origin      = node.role == "ingest-origin"
      enable_edge        = node.role == "edge"
    }))
  })
}

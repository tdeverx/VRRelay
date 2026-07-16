# Generic VM deployment

This module deliberately creates no cloud resources. Use provider-specific
OpenTofu modules for Hetzner, AWS, Azure, GCP, Proxmox, OpenStack, bare-metal, or
your own provider, then pass their VM instances the rendered
`cloud_init_user_data` output from this module.

The module renders one cloud-init document per supplied node. Each document is
role-specific, uses externally managed PostgreSQL, Valkey, and object storage,
mounts persistent host directories for relay data/cache, starts the matching
Docker Compose profile, and runs a timer that removes `VRRELAY_NODE_JOIN_TOKEN`
from `/etc/vrrelay/node.env` after the node identity is persisted.

Release deployments must pass immutable image references pinned by digest for
both VRRelay and MediaMTX. The `cloud_init_user_data` output is sensitive because
it contains bootstrap secrets; retain `cloud_init_sha256` with deployment
evidence instead of logging user data.

```hcl
module "vrrelay_vm_user_data" {
  source = "./deploy/opentofu"

  image_ref          = "ghcr.io/tdeverx/vrrelay@sha256:<release-digest>"
  mediamtx_image_ref = "docker.io/bluenviron/mediamtx@sha256:<release-digest>"

  postgres_url          = var.postgres_url
  valkey_url            = var.valkey_url
  master_key            = var.master_key
  media_mtx_read_token  = var.media_mtx_read_token
  trusted_proxy_cidrs   = var.trusted_proxy_cidrs
  object_store_env      = var.object_store_env

  nodes = {
    controller = {
      role            = "controller"
      name            = "Controller"
      region          = "home"
      public_url      = "https://relay.example.com"
      setup_token     = var.controller_setup_token
      agent_tls_names = "relay-agent.example.com"
    }

    edge_london = {
      role                      = "edge"
      name                      = "London edge"
      region                    = "eu-west"
      public_url                = "https://edge-london.example.com"
      controller_agent_url      = "wss://relay-agent.example.com/api/v1/nodes/connect"
      controller_enrollment_url = "https://relay.example.com"
      join_token                = var.edge_london_join_token
      live_origin_url           = "srt://origin.example.com:8890"
      live_srt_passphrase       = var.live_srt_passphrase
    }
  }
}
```

The cluster runtime only needs outbound access to the controller, PostgreSQL,
Valkey, object storage, and the chosen overlay network. Provider-specific
network, DNS, load-balancer, firewall, and Anycast modules remain optional.

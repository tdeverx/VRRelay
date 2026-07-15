# Generic VM deployment

This module deliberately creates no cloud resources. Supply VM addresses from
OpenTofu modules for Hetzner, AWS, Azure, GCP, Proxmox, OpenStack, or your own
provider, then render `../cloud-init/vrrelay-node.yaml` as instance user data.

The cluster runtime only needs outbound access to the controller, PostgreSQL,
Valkey, object storage, and the chosen overlay network. Provider-specific
network, DNS, load-balancer, and Anycast modules remain optional.

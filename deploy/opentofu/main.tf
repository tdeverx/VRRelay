locals {
  base_env = merge(
    {
      VRRELAY_ENVIRONMENT         = "production"
      VRRELAY_DATA_DIR            = "/data"
      VRRELAY_CACHE_DIR           = "/cache"
      VRRELAY_SECRET_BACKEND      = "encrypted-file"
      VRRELAY_TRUSTED_PROXY_CIDRS = var.trusted_proxy_cidrs
      VRRELAY_VIEWER_REGION_HEADER = "x-vrrelay-region"
      VRRELAY_VOD_PRODUCER_IDLE_TIMEOUT = "60s"
      VRRELAY_VOD_PRODUCER_BUFFER_LOW_WATERMARK = "30s"
      VRRELAY_VOD_PRODUCER_BUFFER_HIGH_WATERMARK = "60s"
      VRRELAY_VOD_PRODUCER_MAX_CONCURRENT = "2"
      VRRELAY_VOD_PRODUCER_MAX_PER_PROVIDER = "2"
      VRRELAY_VOD_PRODUCER_SEEK_COOLDOWN = "5s"
      VRRELAY_REPOSITORY_DRIVER   = "postgres"
      VRRELAY_POSTGRES_URL        = var.postgres_url
      VRRELAY_COORDINATION_DRIVER = "valkey"
      VRRELAY_VALKEY_URL          = var.valkey_url
      VRRELAY_MASTER_KEY          = var.master_key
      VRRELAY_MEDIAMTX_READ_TOKEN = var.media_mtx_read_token
      VRRELAY_OBJECT_STORE_PREFIX = lookup(var.object_store_env, "VRRELAY_OBJECT_STORE_PREFIX", "segments")
    },
    var.object_store_env,
    var.common_env
  )

  role_env = {
    for node_key, node in var.nodes : node_key => merge(
      {
        VRRELAY_NODE_ID       = node.node_id != "" ? node.node_id : node_key
        VRRELAY_NODE_NAME     = node.name
        VRRELAY_NODE_REGION   = node.region
        VRRELAY_NODE_ROLES    = node.role
        VRRELAY_PUBLIC_URL    = node.public_url
        VRRELAY_METRICS_TOKEN = node.metrics_token
      },
      node.role == "controller" ? {
        VRRELAY_LISTEN_ADDR       = "0.0.0.0:8099"
        VRRELAY_SETUP_TOKEN       = node.setup_token
        VRRELAY_AGENT_LISTEN_ADDR = "0.0.0.0:8100"
        VRRELAY_AGENT_TLS_NAMES   = node.agent_tls_names
      } : {},
      node.role != "controller" ? {
        VRRELAY_CONTROLLER_AGENT_URL      = node.controller_agent_url
        VRRELAY_CONTROLLER_ENROLLMENT_URL = node.controller_enrollment_url
        VRRELAY_NODE_JOIN_TOKEN           = node.join_token
      } : {},
      node.role == "ingest-origin" ? {
        VRRELAY_LISTEN_ADDR                  = "0.0.0.0:8099"
        VRRELAY_MEDIAMTX_API_URL             = "http://mediamtx-origin:9997"
        VRRELAY_MEDIAMTX_RTSP_URL            = "rtsp://mediamtx-origin:8554"
        VRRELAY_MEDIAMTX_HLS_URL             = "http://mediamtx-origin:8888"
        VRRELAY_MEDIAMTX_ALLOW_INTERNAL_READ = "true"
        VRRELAY_LIVE_SRT_PASSPHRASE          = node.live_srt_passphrase
      } : {},
      node.role == "edge" ? {
        VRRELAY_LISTEN_ADDR         = "0.0.0.0:8099"
        VRRELAY_MEDIAMTX_HLS_URL    = "http://mediamtx-edge:8888"
        VRRELAY_MEDIAMTX_API_URL    = "http://mediamtx-edge:9997"
        VRRELAY_MEDIAMTX_RTSP_URL   = "rtsp://mediamtx-edge:8554"
        VRRELAY_LIVE_ORIGIN_URL     = node.live_origin_url
        VRRELAY_LIVE_SRT_PASSPHRASE = node.live_srt_passphrase
      } : {},
      node.extra_env
    )
  }

  node_env = {
    for node_key, env in local.role_env : node_key => merge(
      local.base_env,
      {
        for key, value in env : key => value
        if value != ""
      }
    )
  }

  runtime_env = {
    for node_key, env in local.node_env : node_key => join("\n", [
      for key in sort(keys(env)) : "      ${key}=${env[key]}"
    ])
  }

  mediamtx_env = {
    for node_key, node in var.nodes : node_key => join("\n", concat(
      ["      MTX_WEBRTCADDITIONALHOSTS=${node.webrtc_additional_hosts}"],
      node.role == "ingest-origin" ? ["      MTX_PATHDEFAULTS_SRTREADPASSPHRASE=${node.live_srt_passphrase}"] : []
    ))
  }

  relay_ports_block = {
    controller    = "          ports:\n            - '8099:8099'\n            - '8100:8100'"
    source-worker = ""
    ingest-origin = ""
    edge          = "          ports:\n            - '8099:8099'"
  }
}

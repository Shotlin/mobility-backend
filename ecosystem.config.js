// PM2 production config — Raahi mobility (spec 03 §3 deployment units).
// 2 vCPU / 4 GB nodes: max two Node processes per node (spec 03 §6);
// API and realtime share the HTTP server but are deployed as separate
// process types when the realtime pool needs independent scaling.
module.exports = {
  apps: [
    {
      name: 'raahi-api',
      script: './src/server.js',
      instances: 2,
      exec_mode: 'cluster',
      max_memory_restart: '1500M',
      node_args: '--max-old-space-size=1400',
      env_production: {
        NODE_ENV: 'production',
        PORT: 4500,
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 1000,
      max_restarts: 10,
      kill_timeout: 10000,
      listen_timeout: 10000,
      wait_ready: true,
    },
    {
      name: 'raahi-worker-general',
      script: './src/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        WORKER_PROCESS: 'general',
      },
      max_memory_restart: '1000M',
      kill_timeout: 10000,
      wait_ready: true,
    },
    {
      name: 'raahi-worker-dispatch',
      script: './src/worker.js',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        WORKER_PROCESS: 'dispatch',
      },
      max_memory_restart: '1000M',
      kill_timeout: 10000,
      wait_ready: true,
    },
  ],
}

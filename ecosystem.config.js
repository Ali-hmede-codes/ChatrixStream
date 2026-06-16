module.exports = {
  apps: [
    {
      name: 'chatrixstream',
      script: 'server.js',

      exec_mode: 'fork',
      instances: 1,

      max_memory_restart: '2G',

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      log_type: 'json',

      max_restarts: 30,
      restart_delay: 3000,
      autorestart: true,
      watch: false,

      kill_timeout: 10000,
      listen_timeout: 10000,
      shutdown_timeout: 15000,
    },
    {
      // MediaMTX sidecar — the media server that handles HLS/RTSP
      // Download from: https://github.com/bluenviron/mediamtx/releases
      // Place mediamtx.exe (Windows) or mediamtx (Linux/Mac) in the project root
      name: 'mediamtx',
      script: 'mediamtx.exe',
      args: 'mediamtx.yml',

      exec_mode: 'fork',
      instances: 1,

      autorestart: true,
      watch: false,

      max_restarts: 30,
      restart_delay: 3000,

      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/mediamtx-error.log',
      out_file: './logs/mediamtx-out.log',
      merge_logs: true,

      kill_timeout: 10000,
      listen_timeout: 10000,
    },
  ],
};

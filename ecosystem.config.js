module.exports = {
  apps: [
    {
      name: 'chatrixstream',
      script: 'server.js',

      exec_mode: 'fork',
      instances: 1,

      max_memory_restart: '8G',

      node_args: [
        '--max-old-space-size=8192',
        '--max-semi-space-size=256',
      ],

      env: {
        NODE_ENV: 'production',
        UV_THREADPOOL_SIZE: 128,
        PORT: 3001,
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

      kill_timeout: 15000,
      listen_timeout: 15000,
      shutdown_timeout: 20000,
    },
  ],
};

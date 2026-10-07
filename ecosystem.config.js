const apps = [
  {
    name: 'friday-bot',
    script: 'src/index.js',
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      TIMEZONE: process.env.TIMEZONE || 'Asia/Dhaka',
      DB_PATH: process.env.DB_PATH || ''
    }
  },
  {
    name: 'friday-dashboard',
    script: 'src/server.js',
    autorestart: true,
    watch: false,
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000,
      HOST: process.env.HOST || '0.0.0.0',
      TIMEZONE: process.env.TIMEZONE || 'Asia/Dhaka',
      DB_PATH: process.env.DB_PATH || ''
    }
  }
];

export { apps };
export default { apps };

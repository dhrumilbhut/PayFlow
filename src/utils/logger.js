const pino = require('pino');
const config = require('../config');

const logger = pino({
  level: config.log.level,
  base: { service: config.serviceName },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.env === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    },
  }),
});

module.exports = logger;

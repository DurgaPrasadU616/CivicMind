import winston from 'winston';
import { env } from './env';

const logDir = 'logs';

const logFormat = winston.format.combine(
  env.NODE_ENV === 'production'
    ? winston.format.json()
    : winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} [${level}]: ${message}${metaStr}`;
        })
      )
);

const fileRotateTransport = new winston.transports.File({
  filename: `${logDir}/error.log`,
  level: 'error',
  maxsize: 5242880,
  maxFiles: 5,
  format: winston.format.json(),
});

const combinedTransport = new winston.transports.File({
  filename: `${logDir}/combined.log`,
  maxsize: 5242880,
  maxFiles: 5,
  format: winston.format.json(),
});

export const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: logFormat,
  defaultMeta: { service: 'civicmind-backend' },
  transports: [fileRotateTransport, combinedTransport],
});

if (env.NODE_ENV !== 'test') {
  logger.add(
    new winston.transports.Console({
      format: logFormat,
    })
  );
}

export const logStream = {
  write: (message: string) => {
    logger.info(message.trim());
  },
};
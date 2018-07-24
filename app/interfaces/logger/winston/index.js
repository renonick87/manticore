const winston = require('winston');
const config = require('./config.js');

const logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(), 
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
    ),
    transports: [
        new winston.transports.Console({
            level: config.level
        }),
        new winston.transports.File({ //only write warns and errors to file
            level: 'warn',
            name: 'manticore_logs',
            filename: 'manticore_logs.log'
        })
    ],
    exitOnError: false
});

module.exports = {
    debug: logger.debug,
    info: logger.info,
    warn: logger.warn,
    error: logger.error
}
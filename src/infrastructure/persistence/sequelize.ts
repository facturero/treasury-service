import { Sequelize } from 'sequelize';
import { config } from '../config.js';

export const sequelize = new Sequelize(config.DB_NAME, config.DB_USER, config.DB_PASSWORD, {
  host: config.DB_HOST,
  port: config.DB_PORT,
  dialect: 'mysql',
  logging: config.NODE_ENV === 'development' ? console.log : false,
  define: {
    underscored: true,
    charset: 'utf8mb4',
  },
  pool: {
    max: 10,
    min: 0,
    idle: 10000,
  },
});

require('./config/env');
const { app } = require('electron');
const { createMainWindow } = require('./windows/createMainWindow');
const { bootRuntime } = require('./pipeline/runtime');

bootRuntime({ app, createMainWindow });

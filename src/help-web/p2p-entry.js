'use strict';

// Helfer-Seite (GitHub Pages): Direktverbindung zum PC als globales PKP2P (vibeworks #219).
const { connectP2P } = require('../shared/p2p');

window.PKP2P = { connect: connectP2P };

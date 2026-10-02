import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const app = import.meta.env.MODE === 'test' ? <App /> : <React.StrictMode><App /></React.StrictMode>;

createRoot(document.getElementById('root')).render(app);

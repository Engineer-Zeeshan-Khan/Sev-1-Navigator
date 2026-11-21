import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import './style.css';
// This is the single renderer entry point for both the dashboard and the floating timer route.
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);

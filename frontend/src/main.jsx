import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import './index.css';

// Entry point: find the empty <div id="root"> in index.html and render the whole
// React app into it. createRoot is the React 18 way to mount a tree.
ReactDOM.createRoot(document.getElementById('root')).render(
  // StrictMode adds extra checks in development only. It deliberately mounts each
  // component, runs its effects, and runs them again to catch mistakes. That is why
  // later code guards its socket/effect setup so the double run does no harm.
  <React.StrictMode>
    {/* BrowserRouter gives every component access to the URL (routes, params) and to
        navigation, so <Routes> in App can decide which page to show. */}
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

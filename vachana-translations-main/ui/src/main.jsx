import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import StreamPage from './StreamPage.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/stream" replace />} />
        <Route path="/youtube" element={<App />} />
        <Route path="/stream" element={<StreamPage />} />
        <Route path="*" element={<Navigate to="/stream" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)

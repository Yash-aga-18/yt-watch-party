import { Routes, Route, Navigate } from 'react-router-dom';
import HomePage from './pages/HomePage.jsx';
import RoomPage from './pages/RoomPage.jsx';

// Maps each URL to the page component that should render for it.
export default function App() {
  return (
    <Routes>
      {/* Home: start a new room or join one with a code/link. */}
      <Route path="/" element={<HomePage />} />
      {/* A room page. ":code" is a URL parameter read inside RoomPage. */}
      <Route path="/room/:code" element={<RoomPage />} />
      {/* Any unknown URL is sent back to home, replace keeps it out of history. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

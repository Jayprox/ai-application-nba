import { BrowserRouter, Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Scoreboard from './pages/Scoreboard.jsx';
import BoxScore from './pages/BoxScore.jsx';
import ComingSoon from './pages/ComingSoon.jsx';
import NotFound from './pages/NotFound.jsx';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Scoreboard />} />
            <Route path="games/:id" element={<BoxScore />} />
            <Route path="teams/*" element={<ComingSoon title="Teams" />} />
            <Route path="players/*" element={<ComingSoon title="Players" />} />
            <Route path="leaders" element={<ComingSoon title="Leaders" />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

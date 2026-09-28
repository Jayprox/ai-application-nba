import { BrowserRouter, Route, Routes } from 'react-router';
import { AuthProvider, RequireAuth } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Scoreboard from './pages/Scoreboard.jsx';
import BoxScore from './pages/BoxScore.jsx';
import Teams from './pages/Teams.jsx';
import TeamDetail from './pages/TeamDetail.jsx';
import Players from './pages/Players.jsx';
import PlayerDetail from './pages/PlayerDetail.jsx';
import Leaders from './pages/Leaders.jsx';
import Props from './pages/Props.jsx';
import Standings from './pages/Standings.jsx';
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
            <Route path="teams" element={<Teams />} />
            <Route path="teams/:id" element={<TeamDetail />} />
            <Route path="players" element={<Players />} />
            <Route path="players/:id" element={<PlayerDetail />} />
            <Route path="leaders" element={<Leaders />} />
            <Route path="standings" element={<Standings />} />
            <Route path="props" element={<Props />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

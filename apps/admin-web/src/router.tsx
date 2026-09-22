import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppLayout } from './layout/AppLayout';
import Login from './pages/Login';
import Users from './pages/Users';
import Rooms from './pages/Rooms';
import Replay from './pages/Replay';
import Monitor from './pages/Monitor';
import Diag from './pages/Diag';
import Admins from './pages/Admins';
import Audit from './pages/Audit';

export const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/users" replace /> },
      { path: 'users', element: <Users /> },
      { path: 'rooms', element: <Rooms /> },
      { path: 'replay', element: <Replay /> },
      { path: 'replay/:gameId', element: <Replay /> },
      { path: 'diag', element: <Diag /> },
      { path: 'monitor', element: <Monitor /> },
      { path: 'monitor/:roomId', element: <Monitor /> },
      { path: 'admins', element: <Admins /> },
      { path: 'audit', element: <Audit /> },
    ],
  },
  { path: '*', element: <Navigate to="/users" replace /> },
]);

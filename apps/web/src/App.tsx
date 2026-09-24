import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ShellLayout } from './components/Shell';
import { useBootstrap } from './lib/bootstrap';
import AgentProfile from './pages/AgentProfile';
import Agents from './pages/Agents';
import Buy from './pages/Buy';
import Claim from './pages/Claim';
import ControlBoard from './pages/ControlBoard';
import Graveyard from './pages/Graveyard';
import Landing from './pages/Landing';
import Launch from './pages/Launch';
import Market from './pages/Market';
import MyAgents from './pages/MyAgents';
import NotFound from './pages/NotFound';
import Observatory from './pages/Observatory';
import Protocol from './pages/Protocol';
import PurchasePending from './pages/PurchasePending';
import { ChainProviders } from './providers/WalletProvider';

function Bootstrap() {
  useBootstrap();
  return null;
}

export default function App() {
  return (
    <BrowserRouter>
      <ChainProviders>
        <Bootstrap />
        <Routes>
          {/* full-screen, outside the Shell */}
          <Route path="/control/:id" element={<ControlBoard />} />
          <Route element={<ShellLayout />}>
            <Route path="/" element={<Landing />} />
            <Route path="/launch" element={<Launch />} />
            <Route path="/observatory" element={<Observatory />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/a/:id" element={<AgentProfile />} />
            <Route path="/graveyard" element={<Graveyard />} />
            <Route path="/buy" element={<Buy />} />
            <Route path="/buy/:purchaseId" element={<PurchasePending />} />
            <Route path="/claim" element={<Claim />} />
            <Route path="/mine" element={<MyAgents />} />
            <Route path="/market" element={<Market />} />
            <Route path="/protocol" element={<Protocol />} />
            {/* v1 route kept alive so old links land on the buy flow */}
            <Route path="/spawn" element={<Navigate to="/buy" replace />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </ChainProviders>
    </BrowserRouter>
  );
}

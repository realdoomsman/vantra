import { Link } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';

export default function NotFound() {
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">404</h1>
        <p className="page-sub">No route here. Nothing was charged.</p>
      </div>
      <EmptyState title="NOT FOUND" text="This page does not exist or the agent id is wrong.">
        <Link to="/" className="btn-ghost" style={{ display: 'inline-block' }}>BACK TO OBSERVATORY</Link>
      </EmptyState>
    </>
  );
}

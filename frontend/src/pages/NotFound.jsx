import { Link } from 'react-router';
import { Empty } from '../components/States.jsx';
export default function NotFound() {
  return <Empty>That page doesn't exist. <Link to="/">Back to the scoreboard</Link></Empty>;
}

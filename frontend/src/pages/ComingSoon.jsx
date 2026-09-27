import { Empty } from '../components/States.jsx';
export default function ComingSoon({ title }) {
  return (
    <>
      <h1 className="m-0 font-display text-[44px] font-bold leading-none">{title}</h1>
      <Empty>{title} is in the next build slice (after the Scoreboard + Box Score review).</Empty>
    </>
  );
}

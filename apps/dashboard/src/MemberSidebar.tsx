import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Users } from "lucide-react";
import { api } from "./api";

type Rank = { id: string; name: string; color: string; position: number; permissions: string[] };
type Member = { id: string; username: string; systemRole: string; status: string; online: boolean; lastLoginAt?: string; ranks: Rank[] };

export default function MemberSidebar() {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    const load = () => void api.get<Member[]>("/members").then(setMembers).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const groups = useMemo(() => {
    const map = new Map<string, { rank: Rank; members: Member[] }>();
    for (const member of members) {
      const rank = member.ranks[0] || { id: "member", name: "Member", color: "#8792A6", position: 0, permissions: [] };
      const current = map.get(rank.id) || { rank, members: [] };
      current.members.push(member);
      map.set(rank.id, current);
    }
    return [...map.values()].sort((a, b) => b.rank.position - a.rank.position);
  }, [members]);
  return <aside className="member-sidebar" aria-label="Workspace members">
    <header><span><Users /> Members</span><small>{members.filter((member) => member.online).length} online</small></header>
    {groups.map(({ rank, members: ranked }) => <section className="member-rank-group" key={rank.id} style={{ "--member-rank": rank.color } as CSSProperties}>
      <h3><i />{rank.name} — {ranked.length}</h3>
      {ranked.map((member) => <article className={`member-row ${member.online ? "online" : "offline"}`} key={member.id}>
        <span className="member-avatar">{member.username.slice(0, 2).toUpperCase()}<i /></span>
        <span><b>{member.username}</b><small>{member.online ? "Online" : member.status === "DISABLED" ? "Disabled" : member.systemRole.toLowerCase()}</small></span>
      </article>)}
    </section>)}
  </aside>;
}

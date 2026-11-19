"use client";
import { AlertsFeed } from "@/components/alerts-feed";

export default function AlertsPage() {
  return <AlertsFeed limit={200} title="All alerts · live (Supabase Realtime)" />;
}

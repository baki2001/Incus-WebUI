import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import "./extra.css";
import { setUnauthorizedHandler, ui } from "./api";
import { AppProvider, applyTheme, defaultLook, storedLook, type Theme } from "./state";
import { Shell } from "./Shell";
import { Login, takeNext } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Instances } from "./pages/Instances";
import { InstancePage } from "./pages/Instance";
import { Images } from "./pages/Images";
import { Acls, Ipam, Networks } from "./pages/Networks";
import { Buckets, Isos, Pools, Volumes } from "./pages/Storage";
import { Profiles } from "./pages/Profiles";
import { Projects } from "./pages/Projects";
import { Audit, Operations, Tasks, Warnings } from "./pages/Activity";
import { Settings } from "./pages/Settings";
import { Host } from "./pages/Host";
import { Tunnels } from "./pages/Tunnels";
import { BackupsPage } from "./pages/Backups";

type AuthInfo = { setup_required: boolean; password: boolean; oidc: boolean; oidc_label?: string; theme: Theme; user?: string; method?: string };

function Root() {
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const load = () =>
    ui<AuthInfo>("/auth").then((d) => {
      // Back from single sign-on: go to the page that was open before signing in.
      if (d.user && location.pathname === "/") {
        const n = takeNext();
        if (n) history.replaceState(null, "", n);
      }
      setAuth(d);
    });
  useEffect(() => {
    load();
    setUnauthorizedHandler(() => load());
  }, []);
  useEffect(() => {
    applyTheme(storedLook() || defaultLook());
  }, []);
  if (!auth) return null;
  if (!auth.user) return <Login info={auth} onDone={load} />;
  return (
    <AppProvider user={auth.user} method={auth.method || "password"}>
      <BrowserRouter>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<Overview />} />
            <Route path="/instances" element={<Instances />} />
            <Route path="/instances/:server/:name/:tab?" element={<InstancePage />} />
            <Route path="/images" element={<Images />} />
            <Route path="/storage" element={<Pools />} />
            <Route path="/storage/volumes" element={<Volumes />} />
            <Route path="/storage/buckets" element={<Buckets />} />
            <Route path="/storage/isos" element={<Isos />} />
            <Route path="/networks" element={<Networks />} />
            <Route path="/networks/acls" element={<Acls />} />
            <Route path="/networks/ipam" element={<Ipam />} />
            <Route path="/tunnels" element={<Tunnels />} />
            <Route path="/profiles" element={<Profiles />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/backups" element={<BackupsPage />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/operations" element={<Operations />} />
            <Route path="/warnings" element={<Warnings />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/hosts/:server" element={<Host />} />
            <Route path="/settings/:section?" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

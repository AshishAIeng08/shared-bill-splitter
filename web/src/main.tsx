import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { HomePage } from "./page";
import "./style.css";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <header className="top">
        <Link className="brand" to="/">
          common<span>.</span>
        </Link>
        <span className="top-note">A little less awkward, together.</span>
        <span className="avatar">H</span>
      </header>
      <Outlet />
    </>
  ),
});
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});
const routeTree = rootRoute.addChildren([homeRoute]);
const router = createRouter({ routeTree });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("App root element was not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);

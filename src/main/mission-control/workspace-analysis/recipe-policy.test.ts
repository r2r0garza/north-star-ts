import { describe, expect, it } from "vitest"
import { recipeCommandRefusal, recipeRefusal } from "./policy"

// Recipe command policy (plan 112.3): the builder's own shell policy, plus
// no installs and no stand-in apps written into the command line.

describe("recipeCommandRefusal", () => {
  const refused = (command: string) => recipeCommandRefusal(command, "/repo")

  it("allows ordinary ways of starting a project", () => {
    for (const command of [
      "npm start",
      "npm run dev -- --port {port} --strictPort",
      "node server.js",
      "node -r ts-node/register src/index.ts",
      "node --inspect server.js",
      "python app.py -p {port}",
      "python3 manage.py runserver 127.0.0.1:{port} --noreload",
      "python -m http.server {port}",
      "bundle exec puma -p $PORT",
    ])
      expect(refused(command), command).toBeNull()
  })

  it("refuses a stand-in server written into the command line", () => {
    for (const command of [
      `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"`,
      `node --eval "x"`,
      `/usr/local/bin/node -p "1"`,
      `python3 -c "import http.server"`,
      `ruby -e "puts 1"`,
      `bash -c "node server.js"`,
      `deno eval "Deno.serve(() => new Response('ok'))"`,
    ])
      expect(refused(command), command).toMatch(/project's own code/)
  })

  it("refuses chaining, installs, and sudo", () => {
    expect(refused("node migrate.js && node server.js")).toMatch(/one command/)
    expect(refused("npm install")).toMatch(/installing dependencies/)
    expect(refused("pip install -r requirements.txt")).toMatch(
      /installing dependencies/
    )
    expect(refused("sudo service postgresql start")).toMatch(/sudo/)
  })
})

describe("recipeRefusal", () => {
  it("checks services, setup steps, and command prerequisites", () => {
    const service = { label: "Web", command: "node server.js", cwd: "" }
    expect(recipeRefusal({ services: [service] }, "/repo")).toBeNull()
    expect(
      recipeRefusal(
        {
          services: [service],
          setup: [{ label: "Seed", command: "npm i", cwd: "" }],
        },
        "/repo"
      )
    ).toMatch(/setup step "Seed"/)
    expect(
      recipeRefusal(
        {
          services: [service],
          prerequisites: [
            { label: "Redis", check: { command: "sudo redis-cli ping" } },
          ],
        },
        "/repo"
      )
    ).toMatch(/check for "Redis"/)
  })
})

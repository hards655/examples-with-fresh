import { define } from "../utils.ts";

export const handler = define.handlers({
GET() {
return new Response(
JSON.stringify({
status: "ok",
message: "Fresh API route works",
}),
{
headers: {
"Content-Type": "application/json; charset=utf-8",
},
},
);
},
});

// This script is intended to be run in a Cloudflare Worker environment.
// It lists the files in the 'assets' directory of the deployment.

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  // This is a simplified example. In a real Cloudflare Worker,
  // you would need a way to get the list of assets.
  // One way is to have a build step that generates a JSON file
  // with the asset list, and this worker would serve that JSON file.

  // For this example, we'll return a hardcoded list.
  // In a real implementation, you would replace this with a dynamic list.
  const assetList = {
    "乾隆大藏经txt版": [
      "示例.txt"
    ],
    "咒语": [
      "楞严咒.txt"
    ],
    "房山石经陀罗尼梵音音频": [
      "示例.mp3"
    ],
    "经文": [
      "心经.txt"
    ]
  };

  return new Response(JSON.stringify(assetList), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*' // Allow cross-origin requests
    },
  })
}
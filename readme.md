# FireFlower
Scalable and resilient data broadcasting between peers, using Firebase as the backend, and k as the maximum number of downstream connections from any one peer.

A "broadcaster" is the one (and only one) peer that will be at the root of the tree. A "listener" is any peer that will be receiving the data being broadcast.

Set the broadcaster with the setBroadcaster() function, and add each new listener with the addListener() function. When the broadcaster is set or any new listener is added, an entry is created in Firebase under the 'available_peers' node. Any child of 'available_peers' is considered to be available in that it isn't yet full with downstream listeners.

Scenarios:
1. Listener is added: When a new listener A is added, the first available peer B is picked from the list, and an entry for A is added to B's list of listeners.
2. Full node: When B's list of listeners is full (i.e. the number of listeners equals k), the Firebase element for B is removed from the 'available_peers' node, so no new listeners can find it
3. Listener is removed: When a listener A is removed, if A has any downstream listeners in its 'listeners' Firebase node, for each one find an available substitute by pulling one from the 'available_peers' node (that isn't the one to be removed or itself). Once that is done, listener A is removed from its upstream peer B's list of listeners (not implemented yet!), so that space can be made available for a new peer.
4. Broadcaster is removed: (not implemented yet!)

## Firebase
Make sure to have set up a Firebase account and database, set the rules as described in the etc/rules.json file, and pass the Firebase URL to the FireFlower constructor.

## Example
`npm run example`

When the page first loads, a broadcaster is created and added to the tree. Click the "Add Listener" button to add addition listeners. Right now the page doesn't show anything, but be watching Firebase to see how the connections are being made. To remove a peer, type the ID in the text box and click the "Remove Listener" button, and see the remapping being done in Firebase.

## Note
Just a prototype for the moment!

## License
MIT

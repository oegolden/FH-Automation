class TicketCache {
    constructor() {
        this.tickets = new Map(); // ticket_id -> { email, newSummaryAvailable, updateSent, aiSummary }
    }

    addTicket(ticketId, email, aiSummary) {
        this.tickets.set(ticketId, {
            email,
            newSummaryAvailable: true,
            updateSent: false,
            aiSummary
        });
    }

    markUpdateSent(ticketId) {
        const ticketDetails = this.tickets.get(ticketId);
        if (ticketDetails) {
            ticketDetails.updateSent = true;
            ticketDetails.newSummaryAvailable = false;
            this.tickets.set(ticketId, ticketDetails);
        }
    }

    getTicket(ticketId) {
        return this.tickets.get(ticketId);
    }

    getAllTickets() {
        return this.tickets;
    }
}

module.exports = new TicketCache();

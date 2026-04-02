import SwiftUI

struct AssetToolbarModifier: ViewModifier {
    @EnvironmentObject var service: AnalysisService
    @EnvironmentObject var favorites: FavoritesStore
    @EnvironmentObject var coordinator: NavigationCoordinator
    @Binding var showPicker: Bool
    @Binding var showWatchlist: Bool

    private var selectedSymbol: String {
        service.currentSymbol ?? Constants.allCoins[0].id
    }

    func body(content: Content) -> some View {
        content
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        withAnimation { favorites.toggleFavorite(selectedSymbol) }
                        if favorites.isFavorite(selectedSymbol) && service.resultsBySymbol[selectedSymbol] == nil {
                            Task { await service.quickFetch(symbol: selectedSymbol) }
                        }
                    } label: {
                        Image(systemName: favorites.isFavorite(selectedSymbol) ? "star.fill" : "star")
                            .foregroundStyle(favorites.isFavorite(selectedSymbol) ? .yellow : Color(.label))
                    }
                }

                ToolbarItem(placement: .navigationBarLeading) {
                    Button { showWatchlist = true } label: {
                        Image(systemName: "square.grid.2x2")
                    }
                }

                ToolbarItem(placement: .principal) {
                    Button { showPicker = true } label: {
                        HStack(spacing: 4) {
                            Text(Constants.asset(for: selectedSymbol)?.ticker ?? selectedSymbol)
                                .font(.headline)
                            Image(systemName: "chevron.down")
                                .font(.caption2)
                        }
                        .foregroundStyle(Color(.label))
                    }
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        HapticManager.impact(.medium)
                        Task { await service.runFullAnalysis(symbol: selectedSymbol) }
                    } label: {
                        if service.aiLoadingPhase != .idle {
                            ProgressView()
                                .controlSize(.small)
                                .transition(.opacity)
                        } else {
                            Image(systemName: "sparkles")
                                .symbolEffect(.pulse, isActive: service.isAIStale || service.currentResult?.claudeAnalysis.isEmpty == true)
                                .foregroundStyle(service.isAIStale || service.currentResult?.claudeAnalysis.isEmpty == true ? Color.accentColor : Color(.label))
                                .transition(.opacity)
                        }
                    }
                    .animation(.easeInOut(duration: 0.2), value: service.aiLoadingPhase)
                    .disabled(service.aiLoadingPhase != .idle)
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { coordinator.showSettings = true } label: {
                        Image(systemName: "gear")
                    }
                }
            }
    }
}
